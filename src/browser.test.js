import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

async function until(probe) {
  for (let i = 0; i < 100; i++) {
    try { const result = await probe(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture startup timed out");
}

test("browser API rejects large prompts, accepts reformulation and preserves ambiguous sends", { skip: process.env.MUSE_BRIDGE_BROWSER_TEST !== "1", timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-browser-test-"));
  const children = [];
  function child(command, args, options = {}) {
    const process = spawn(command, args, { stdio: "ignore", ...options });
    children.push({ process, exited: new Promise((resolve) => process.once("exit", resolve)) });
    return process;
  }
  const fixture = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<textarea placeholder="Message"></textarea><button onclick="send()">Send</button><main></main><script>
      let count=0;
      function send(){
        const prompt=document.querySelector('textarea').value;
        history.replaceState({},'', '/thread/fixture');
        const user=document.createElement('div');
        user.dataset.messageId='user-'+(++count);user.dataset.messageRole='user';
        const p=document.createElement('p');p.textContent=prompt;user.append(p);
        document.querySelector('main').append(user);
        if(prompt.length>500 || prompt.includes('AMBIGUOUS')){
          const alert=document.createElement('span');alert.setAttribute('role','alert');
          alert.textContent=prompt.length>500?'Message is too long':'Message failed to send';user.append(alert);
        }else{
          const reply=document.createElement('div');reply.dataset.messageId='reply-'+count;reply.dataset.messageRole='assistant';
          const body=document.createElement('div');body.setAttribute('data-hatch-assistant-message-body','');body.textContent='FIXTURE_OK';reply.append(body);document.querySelector('main').append(reply);
        }
        document.querySelector('textarea').value='';
      }
    </script>`);
  });
  let browser;
  try {
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const profile = join(directory, "chromium");
    child(process.env.MUSE_CHROMIUM_BIN || "chromium", ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-allow-origins=http://localhost", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"]);
    const cdpPort = await until(async () => (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    const cdp = `http://127.0.0.1:${cdpPort}`;
    browser = await chromium.connectOverCDP(cdp);
    const page = browser.contexts()[0].pages()[0];
    await page.goto(origin);
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    child(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url))], {
      env: { ...process.env, MUSE_URL: origin, MUSE_NEW_CHAT_URL: origin + "/thread/new", MUSE_BRIDGE_HOST: "127.0.0.1", MUSE_BRIDGE_PORT: String(port), MUSE_BRIDGE_DATA: directory, MUSE_CDP_ENDPOINT: cdp, MUSE_AUTH_BROWSER: "0", MUSE_MAX_PROMPT_CHARS: "1000" },
    });
    const base = `http://127.0.0.1:${port}`;
    const html = await until(async () => (await fetch(base)).text());
    const token = JSON.parse(html.match(/const token=("[a-f0-9]+");const config=/)[1]);
    await until(async () => (await (await fetch(base + "/control/status", { headers: { "X-Control-Token": token } })).json()).authenticated);
    const key = (await readFile(join(directory, "api-key"), "utf8")).trim();
    const send = async (text, session = "fixture") => {
      const response = await fetch(base + "/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Muse-Session-Id": session },
        body: JSON.stringify({ messages: [{ role: "user", content: text }] }), signal: AbortSignal.timeout(12000),
      });
      return { status: response.status, body: await response.json() };
    };
    let result = await send("x".repeat(2000));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "context_length_exceeded");
    assert.equal(await page.locator('[data-message-role="user"]').count(), 0);
    result = await send("x".repeat(600));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "muse_prompt_too_large");
    let state = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
    assert.equal(state.fixture.pendingSubmission, undefined);
    result = await send("Responda OK");
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, "FIXTURE_OK");
    result = await send("AMBIGUOUS", "uncertain");
    assert.equal(result.status, 409);
    state = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
    assert.ok(state.uncertain.pendingSubmission);
    assert.equal((await send("another message", "uncertain")).status, 409);
  } finally {
    // Stop the bridge before its browser to avoid reconnection during cleanup.
    for (const item of children.reverse()) { item.process.kill("SIGTERM"); await item.exited; }
    if (browser?.isConnected()) await browser.close();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
