import test from "node:test";
import assert from "node:assert/strict";
import { createRequestQueue } from "./queue.js";

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

test("queue executes FIFO, gives execution its own start and continues after failure", async () => {
  const queue = createRequestQueue();
  const held = gate();
  const order = [];
  const first = queue.run(async () => { order.push(1); await held.promise; });
  const second = queue.run(() => { order.push(2); throw new Error("failed"); });
  const failure = assert.rejects(second, /failed/);
  const third = queue.run((waitedMs) => { assert.ok(waitedMs >= 0); order.push(3); return "done"; });
  assert.equal(queue.status().waiting, 2);
  await Promise.resolve();
  assert.deepEqual(order, [1]);
  held.release();
  await first;
  await failure;
  assert.equal(await third, "done");
  assert.deepEqual(order, [1, 2, 3]);
});

test("queue bounds waiting and rejects overlapping calls from the same session", async () => {
  const queue = createRequestQueue({ maxWaiting: 1 });
  const held = gate();
  const first = queue.run(() => held.promise, { sessionId: "a" });
  await assert.rejects(queue.run(() => assert.fail("duplicate ran"), { sessionId: "a" }), (e) => e.code === "session_busy" && e.status === 503 && e.retryable);
  const second = queue.run(() => "second", { sessionId: "b" });
  await assert.rejects(queue.run(() => assert.fail("full queue ran"), { sessionId: "c" }), (e) => e.status === 429 && e.code === "queue_full");
  held.release();
  await first;
  assert.equal(await second, "second");
});

test("disconnected waiting clients are removed without executing or blocking later work", async () => {
  const queue = createRequestQueue();
  const held = gate();
  const first = queue.run(() => held.promise);
  const controller = new AbortController();
  const cancelled = queue.run(() => assert.fail("cancelled request ran"), { signal: controller.signal });
  const failure = assert.rejects(cancelled, /disconnected/);
  controller.abort(new Error("disconnected"));
  await failure;
  assert.equal(queue.status().waiting, 0);
  const next = queue.run(() => "next");
  held.release();
  await first;
  assert.equal(await next, "next");
});

test("queue timeout rejects while the active job is still running", async () => {
  const queue = createRequestQueue({ waitTimeoutMs: 25 });
  const held = gate();
  const first = queue.run(() => held.promise);
  await assert.rejects(queue.run(() => assert.fail("expired request ran")), (e) => e.status === 503 && e.code === "queue_timeout" && e.retryable);
  assert.equal(queue.status().waiting, 0);
  held.release();
  await first;
});
