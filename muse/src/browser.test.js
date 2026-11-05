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

test("browser API distinguishes loading from login and resumes delayed responses without resending", { skip: process.env.MUSE_BRIDGE_BROWSER_TEST !== "1", timeout: 130000 }, async () => {
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
      const old=document.createElement('div');old.dataset.messageId='old';old.dataset.messageRole='assistant';
      const oldBody=document.createElement('div');oldBody.setAttribute('data-hatch-assistant-message-body','');oldBody.textContent='Histórico antigo';
      Object.defineProperty(oldBody,'innerText',{get(){throw new Error('Old history must not be read');}});
      old.append(oldBody);document.querySelector('main').append(old);
      function send(){
        const prompt=document.querySelector('textarea').value;
        if(!location.pathname.startsWith('/thread/') || location.pathname==='/thread/new') history.replaceState({},'', '/thread/fixture-'+Date.now());
        const user=document.createElement('div');
        user.dataset.messageId='user-'+(++count);user.dataset.messageRole='user';
        const p=document.createElement('p');p.textContent=prompt;user.append(p);
        document.querySelector('main').append(user);
        if(prompt.length>500 || prompt.includes('AMBIGUOUS')){
          const alert=document.createElement('span');alert.setAttribute('role','alert');
          alert.textContent=prompt.length>500?'Message is too long':'Message failed to send';user.append(alert);
        }else if(!prompt.includes('NEVER_REPLY')){
          function finish(){
          const reply=document.createElement('div');reply.dataset.messageId='reply-'+count;reply.dataset.messageRole='assistant';
          reply.setAttribute('aria-busy','false');
          const body=document.createElement('div');body.setAttribute('data-hatch-assistant-message-body','');
          if(prompt.includes('MEDIA_ONLY')){
            const image=document.createElement('img');image.alt='fixture image';image.src='data:image/png;base64,aGVsbG8=';
            reply.append(body,image);document.querySelector('main').append(reply);
            return;
          }
          if(prompt.includes('PAUSED_GENERATION')){
            body.textContent='PARTIAL_RESPONSE';
            reply.append(body);document.querySelector('main').append(reply);
            setTimeout(()=>{body.textContent='FIXTURE_COMPLETE';const copy=document.createElement('button');copy.setAttribute('aria-label','Copy response');reply.append(copy);},2600);
            return;
          }
          if(prompt.includes('JSON_BLOCK')){
            body.append('json');const pre=document.createElement('pre');pre.className='language-json';
            const code=document.createElement('code');code.textContent=JSON.stringify({type:'final',text:'FIXTURE_JSON'});pre.append(code);body.append(pre);
          }else{body.textContent='FIXTURE_OK';}
          const copy=document.createElement('button');copy.setAttribute('aria-label','Copy response');
          reply.append(body,copy);document.querySelector('main').append(reply);
          }
          if(prompt.includes('SLOW_REPLY'))setTimeout(finish,6500);
          else if(prompt.includes('SLOW_CLIENT'))setTimeout(finish,1400);
          else finish();
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
    const startServer = (timeout = 180000) => child(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url))], {
      env: { ...process.env, MUSE_URL: origin, MUSE_NEW_CHAT_URL: origin + "/thread/new", MUSE_BRIDGE_HOST: "127.0.0.1", MUSE_BRIDGE_PORT: String(port), MUSE_BRIDGE_DATA: directory, MUSE_CDP_ENDPOINT: cdp, MUSE_AUTH_BROWSER: "0", MUSE_MAX_PROMPT_CHARS: "1000", MUSE_REQUEST_TIMEOUT_MS: String(timeout) },
    });
    let serverProcess = startServer();
    const base = `http://127.0.0.1:${port}`;
    const html = await until(async () => (await fetch(base)).text());
    const token = JSON.parse(html.match(/const token=("[a-f0-9]+");const config=/)[1]);
    await until(async () => (await (await fetch(base + "/control/status", { headers: { "X-Control-Token": token } })).json()).authenticated);
    const key = (await readFile(join(directory, "api-key"), "utf8")).trim();
    const send = async (text, session = "fixture", signal) => {
      const response = await fetch(base + "/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Muse-Session-Id": session },
        body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
      });
      return { status: response.status, body: await response.json(), retryAfter: response.headers.get("retry-after") };
    };
    const waitReady = async () => {
      const html = await until(async () => (await fetch(base)).text());
      const token = JSON.parse(html.match(/const token=("[a-f0-9]+");const config=/)[1]);
      await until(async () => (await (await fetch(base + "/control/status", { headers: { "X-Control-Token": token } })).json()).authenticated);
    };
    await page.evaluate(() => { document.querySelector('textarea').style.display = 'none'; setTimeout(() => { document.querySelector('textarea').style.display = ''; }, 6000); });
    let result = await send("Espere a página ficar pronta", "delayed");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.choices[0].message.content, "FIXTURE_OK");
    await page.evaluate(() => { document.querySelector('textarea').style.display = 'none'; });
    const beforeUnavailable = await page.locator('[data-message-role="user"]').count();
    result = await send("Não envie enquanto a página estiver indisponível", "unavailable");
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "muse_page_not_ready");
    assert.equal(result.body.error.retryable, true);
    assert.equal(await page.locator('[data-message-role="user"]').count(), beforeUnavailable);
    const status = await (await fetch(base + "/control/status", { headers: { "X-Control-Token": token } })).json();
    assert.match(status.state, /perda de login não confirmada/);
    await page.evaluate(() => { const form = document.createElement('form'); form.id = 'login'; form.innerHTML = '<p>Log in or create an account</p><input type="email">'; document.body.append(form); });
    result = await send("Login realmente necessário", "login");
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, "muse_authentication_required");
    assert.equal(result.body.error.retryable, false);
    await page.evaluate(() => { document.querySelector('#login').remove(); document.querySelector('textarea').style.display = ''; });
    result = await send("Não envie enquanto a página estiver indisponível", "unavailable");
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, "FIXTURE_OK");
    result = await send("x".repeat(2000));
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
    result = await send("JSON_BLOCK");
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, "FIXTURE_JSON");
    result = await send("MEDIA_ONLY");
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.attachments[0].mime_type, "image/png");
    assert.equal(Buffer.from(result.body.choices[0].message.attachments[0].data, "base64").toString(), "hello");
    const pausedStartedAt = Date.now();
    result = await send("PAUSED_GENERATION");
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, "FIXTURE_COMPLETE");
    assert.ok(Date.now() - pausedStartedAt >= 4000, "partial text without the completion control must not be returned");
    await page.getByRole("button", { name: "Send" }).evaluate((button) => button.remove());
    result = await send("Sem botão de envio");
    assert.equal(result.status, 502);
    state = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
    assert.equal(state.fixture.pendingSubmission, undefined);
    result = await send("AMBIGUOUS", "uncertain");
    assert.equal(result.status, 409);
    state = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
    assert.ok(state.uncertain.pendingSubmission);
    assert.equal((await send("another message", "uncertain")).status, 409);
    const simultaneous = await Promise.all(["one", "two", "three", "four"].map((id) => send("Pedido " + id, "parallel-" + id)));
    for (const result of simultaneous) {
      assert.equal(result.status, 200);
      assert.equal(result.body.choices[0].message.content, "FIXTURE_OK");
    }
    const queueStatus = await (await fetch(base + "/control/status", { headers: { "X-Control-Token": token } })).json();
    assert.equal(queueStatus.queue.waiting, 0);
    const completed = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
    for (const id of ["one", "two", "three", "four"]) assert.equal(completed["parallel-" + id].pendingSubmission, undefined);
    assert.equal(new Set(["one", "two", "three", "four"].map((id) => completed["parallel-" + id].url)).size, 4);
    const disconnectedController = new AbortController();
    const disconnectedRequest = send("SLOW_CLIENT", "client-disconnect", disconnectedController.signal);
    disconnectedRequest.catch(() => {});
    await until(async () => await page.locator('[data-message-role="user"]').count() === 1);
    disconnectedController.abort();
    await assert.rejects(disconnectedRequest, (error) => error.name === "AbortError");
    await until(async () => {
      const saved = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
      return saved["client-disconnect"]?.pendingSubmission === undefined
        && saved["client-disconnect"]?.previousResponse?.choices?.[0]?.message?.content === "FIXTURE_OK";
    });
    result = await send("SLOW_CLIENT", "client-disconnect");
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, "FIXTURE_OK");
    assert.equal(await page.locator('[data-message-role="user"]').count(), 1, "a retry reads the cached completion instead of sending twice");
    serverProcess.kill("SIGTERM");
    await children.at(-1).exited;
    serverProcess = startServer(5000);
    await waitReady();
    result = await send("SLOW_REPLY", "slow");
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "request_timeout");
    assert.equal(result.body.error.retryable, true);
    assert.equal(result.retryAfter, "2");
    state = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
    assert.equal(state.slow.pendingSubmission.recoveryTimeouts, 1);
    assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
    result = await send("SLOW_REPLY", "slow");
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, "FIXTURE_OK");
    assert.equal(await page.locator('[data-message-role="user"]').count(), 1, "resume reads the answer without clicking Send again");
    const cachedId = result.body.id;
    assert.equal((await send("SLOW_REPLY", "slow")).body.id, cachedId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await send("NEVER_REPLY", "stalled");
      assert.equal(result.status, attempt < 3 ? 503 : 409);
      assert.equal(result.body.error.code, attempt < 3 ? "request_timeout" : "submission_review_required");
      assert.equal(result.body.error.retryable, attempt < 3);
      assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
      if (attempt === 1) {
        serverProcess.kill("SIGTERM");
        await children.at(-1).exited;
        serverProcess = startServer(5000);
        await waitReady();
      }
    }
    state = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
    assert.equal(state.stalled.pendingSubmission.recoveryTimeouts, 3, "recovery budget survives restart");
  } finally {
    // Stop the bridge before its browser to avoid reconnection during cleanup.
    for (const item of children.reverse()) { item.process.kill("SIGTERM"); await item.exited; }
    if (browser?.isConnected()) await browser.close();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
