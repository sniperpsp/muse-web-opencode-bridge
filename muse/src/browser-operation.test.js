import test from "node:test";
import assert from "node:assert/strict";
import { withBrowserOperationTimeout } from "./browser-operation.js";

test("a hung browser operation disconnects automation before returning", async () => {
  let disconnected = false;
  await assert.rejects(
    withBrowserOperationTimeout(() => new Promise(() => {}), {
      timeoutMs: 10,
      label: "Leitura da página",
      onInterrupt: () => { disconnected = true; },
    }),
    (error) => error.code === "muse_browser_operation_timeout" && error.retryable === true,
  );
  assert.equal(disconnected, true);
});

test("an aborted browser operation does not start and releases its automation connection", async () => {
  const controller = new AbortController();
  let started = false;
  let disconnected = false;
  const operation = withBrowserOperationTimeout(() => {
    started = true;
    return new Promise(() => {});
  }, {
    timeoutMs: 1000,
    signal: controller.signal,
    onInterrupt: () => { disconnected = true; },
  });
  controller.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
  await assert.rejects(operation, /deadline/);
  assert.equal(started, false);
  assert.equal(disconnected, true);
});
