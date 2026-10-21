import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { conversationMessages, currentReply, finalText, localTitle, looksLikeToolCall, parseContent, parseToolCall, simpleGreeting, transcriptDelta } from "./protocol.js";
import { checkPromptLength, fitHistory, isDeliveryError, isPromptSizeError, needsRotation } from "./protocol.js";
import { updateStatus } from "./updates.js";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

test("HTTP payload limit returns actionable JSON instead of resetting the connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-http-test-"));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url))], {
    env: { ...process.env, MUSE_BRIDGE_DATA: directory, MUSE_BRIDGE_HOST: "127.0.0.1", MUSE_BRIDGE_PORT: String(port), MUSE_AUTH_BROWSER: "0", MUSE_CDP_ENDPOINT: "http://127.0.0.1:1", MUSE_CDP_PORT: "9222", MUSE_AUTH_CDP_PORT: "9223", MUSE_MAX_PROMPT_CHARS: "60000" },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(base)).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "isolated API started");
    const key = (await readFile(join(directory, "api-key"), "utf8")).trim();
    const models = await fetch(base + "/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal((await models.json()).data[0].limits.max_prompt_chars, 60000);
    const dashboard = await (await fetch(base)).text();
    assert.ok(dashboard.includes("Verificar atualização"));
    new Function(dashboard.match(/<script>([\s\S]*?)<\/script>/)[1]); // Validate generated browser JS too.
    const response = await fetch(base + "/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(28 * 1024 * 1024) }] }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 413);
    const { error } = await response.json();
    assert.equal(error.code, "request_too_large");
    assert.equal(error.retryable, false);
    assert.equal(error.limit_bytes, 28 * 1024 * 1024);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects oversized final prompts with actionable non-retryable metadata", () => {
  checkPromptLength("abc", 3);
  assert.throws(() => checkPromptLength("abcd", 3), (error) => error.status === 400 && error.code === "context_length_exceeded" && error.received_chars === 4 && error.limit_chars === 3 && error.retryable === false);
  assert.throws(() => checkPromptLength("", NaN));
  assert.throws(() => checkPromptLength("", 0));
  checkPromptLength("😀", 2); // HTML maxlength and JS length both count UTF-16 units.
});

test("only explicit size errors permit a reformulated submission", () => {
  for (const text of ["Message is too long", "The text you entered is too long", "Mensagem muito longa", "Input exceeds the maximum character count", "Maximum prompt length is 10000"]) assert.ok(isPromptSizeError(text), text);
  for (const text of ["Rate limit exceeded", "Session expired", "Message failed to send", "Usage limit reached", "Too many requests"]) assert.equal(isPromptSizeError(text), false, text);
});

test("update checks distinguish newer commits, divergence and network failures", async () => {
  const revision = "a".repeat(40);
  for (const [status, state] of [["ahead", "available"], ["identical", "current"], ["diverged", "unknown"], ["behind", "unknown"]]) {
    const result = await updateStatus(revision, async () => ({ ok: true, json: async () => ({ status }) }));
    assert.equal(result.state, state);
  }
  assert.equal((await updateStatus(revision, async () => { throw new Error("offline"); })).state, "unknown");
  assert.equal((await updateStatus(revision, async () => ({ ok: false, status: 403 }))).state, "unknown");
  assert.equal((await updateStatus("unknown", () => { throw new Error("must not fetch"); })).state, "unknown");
});

test("handles title metadata without sending a second user message to Muse", () => {
  const user = { role: "user", content: '"Execute pwd no WSL"' };
  assert.equal(localTitle([{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, user]), "Execute pwd no WSL");
  assert.equal(localTitle([{ role: "system", content: "You are OpenCode." }, user]), null);
});

test("returns only assistant replies after a newly submitted user turn", () => {
  const history = [
    { id: "u1", role: "user", text: "Anterior" },
    { id: "a1", role: "assistant", text: "Resposta antiga" },
  ];
  const before = history.map((message) => message.id);
  assert.equal(currentReply(history, before), null);
  assert.deepEqual(currentReply([...history, { id: "u2", role: "user", text: "Agora" }], before), { text: "", busy: false });
  assert.deepEqual(currentReply([...history,
    { id: "u2", role: "user", text: "Agora" },
    { id: "a2", role: "assistant", text: "Resposta antiga", busy: true },
  ], before), { text: "Resposta antiga", busy: true });
  assert.equal(currentReply([...history, { id: "a2", role: "assistant", text: "Histórico atualizado" }], before), null);
});

test("correlates by message ID even when rendering changes text or removes earlier bubbles", () => {
  const before = ["u1", "a1"];
  const visible = [
    { id: "u2", role: "user", text: "Texto normalizado pelo navegador" },
    { id: "a2", role: "assistant", text: '{"type":"tool_call","name":"shell","arguments":{"command":"mkdir -p sample-dir"}}', busy: false },
  ];
  assert.deepEqual(currentReply(visible, before), { text: visible[1].text, busy: false });
  assert.equal(currentReply(visible, ["u2", "a2"]), null);
});

test("filters instructions when detecting a simple greeting", () => {
  const messages = [
    { role: "system", content: "Internal runtime instructions" },
    { role: "developer", content: "Tool routing policy" },
    { role: "user", content: "Boa noite, Muse." },
  ];
  assert.deepEqual(conversationMessages(messages), [{ role: "user", content: "Boa noite, Muse." }]);
});

test("passes a plain greeting through without treating other requests as greetings", () => {
  assert.equal(simpleGreeting(" Boa noite, Muse. "), "Boa noite, Muse.");
  assert.equal(simpleGreeting('"Boa noite, Muse."'), "Boa noite, Muse.");
  assert.equal(simpleGreeting("Liste os arquivos do projeto"), null);
});

test("parses text and inline image content for browser upload", () => {
  const result = parseContent([
    { type: "text", text: "O que aparece nesta imagem?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
  ]);
  assert.equal(result.text, "O que aparece nesta imagem?");
  assert.equal(result.files[0].mimeType, "image/png");
  assert.equal(result.files[0].buffer.toString(), "hello");
});

test("rejects remote media URLs at the API boundary", () => {
  assert.throws(() => parseContent([{ type: "image_url", image_url: { url: "https://example.com/a.png" } }]), /data URL/);
});

test("extracts only new assistant text after the submitted prompt", () => {
  assert.equal(transcriptDelta("old chat", "old chat\nPergunta\nResposta", "Pergunta"), "Resposta");
});

test("extracts the answer from Muse chat bubbles without sidebar text", () => {
  const before = "Você: pergunta anterior\nResposta anterior";
  const prompt = "Conversa do OpenCode:\\nuser: Responda somente OK.\\n\\nContinue a conversa e responda ao pedido mais recente do usuário.";
  const after = `${before}\nVocê:${prompt}\nOK`;
  assert.equal(transcriptDelta(before, after, prompt), "OK");
});

test("preserves quoted Python commands and rejects invalid JSON without executing it", () => {
  const tools = [{ type: "function", function: { name: "shell" } }];
  const command = 'python3 -c "import edge_tts; print(edge_tts.Communicate.__init__.__code__.co_varnames)"';
  const valid = '```json\n' + JSON.stringify({ type: "tool_call", name: "shell", arguments: { command } }) + '\n```';
  assert.deepEqual(parseToolCall(valid, tools), { name: "shell", arguments: { command } });
  const invalid = '{"type":"tool_call","name":"shell","arguments":{"command":"' + command + '"}}';
  assert.equal(parseToolCall(invalid, tools), null);
  assert.equal(parseToolCall('```json\n' + invalid + '\n```', tools), null);
  assert.equal(looksLikeToolCall('```json\n' + invalid + '\n```'), true);
});

test("accepts only a requested OpenCode tool", () => {
  const tools = [{ type: "function", function: { name: "read_file" } }];
  assert.deepEqual(parseToolCall('<opencode_tool_call>{"name":"read_file","arguments":{"path":"a"}}</opencode_tool_call>', tools), {
    name: "read_file",
    arguments: { path: "a" },
  });
  assert.equal(parseToolCall('<opencode_tool_call>{"name":"run_shell","arguments":{}}</opencode_tool_call>', tools), null);
});

test("decodes structured operations and final answers without accepting unknown tools", () => {
  const tools = [{ type: "function", function: { name: "shell" } }];
  const json = '{"type":"tool_call","name":"shell","arguments":{"command":"pwd"}}';
  assert.deepEqual(parseToolCall(json, tools), { name: "shell", arguments: { command: "pwd" } });
  assert.deepEqual(parseToolCall('```json\n' + json + '\n```', tools), { name: "shell", arguments: { command: "pwd" } });
  assert.equal(parseToolCall(json, []), null);
  assert.equal(parseToolCall("null", tools), null);
  assert.equal(parseToolCall('{"name":"shell","arguments":{"command":"pwd"}}', tools), null);
  assert.equal(finalText('{"type":"final","text":"Diretório confirmado."}'), "Diretório confirmado.");
  assert.equal(finalText("Resposta normal"), "Resposta normal");
});

test("parses raw file content blocks without JSON escaping and still checks the requested tool", () => {
  const tools = [
    { type: "function", function: { name: "write" } },
    { type: "function", function: { name: "edit" } },
  ];
  const content = '<!doctype html>\n<main data-title="TesteFlix"><h1>TesteFlix</h1></main>\n';
  const write = [
    "<opencode_tool_call>",
    JSON.stringify({ type: "tool_call", name: "write", arguments: { path: "/workspace/test-site/index.html" } }),
    "<<<MUSE_FILE_CONTENT_BEGIN>>>", "````", content + "\n````", "<<<MUSE_FILE_CONTENT_END>>>", "</opencode_tool_call>",
  ].join("\n");
  assert.deepEqual(parseToolCall(write, tools), {
    name: "write",
    arguments: { path: "/workspace/test-site/index.html", content },
  });
  const edit = [
    "<opencode_tool_call>",
    JSON.stringify({ type: "tool_call", name: "edit", arguments: { path: "a.js", oldString: "const a = 1;" } }),
    "<<<MUSE_FILE_CONTENT_BEGIN>>>", "````", 'const a = <main title="quoted" />;\n````', "<<<MUSE_FILE_CONTENT_END>>>", "</opencode_tool_call>",
  ].join("\n");
  assert.deepEqual(parseToolCall(edit, tools), {
    name: "edit",
    arguments: { path: "a.js", oldString: "const a = 1;", newString: 'const a = <main title="quoted" />;' },
  });
  assert.equal(parseToolCall(write, []), null);
  assert.equal(looksLikeToolCall(write), true);
  assert.equal(looksLikeToolCall('<opencode_tool_call>{"type":"tool_call","name":"write"}'), true);
  assert.equal(looksLikeToolCall("A solicitação foi concluída."), false);
});

test("live API preserves session threads across retries, switching and container restart", {
  skip: process.env.MUSE_BRIDGE_LIVE_TEST !== "1",
  timeout: 120000,
}, async () => {
  const base = "http://127.0.0.1:4317";
  const config = JSON.parse(await readFile(new URL("../opencode.json", import.meta.url), "utf8"));
  const html = await (await fetch(base)).text();
  const match = /const token=("[^"]+");const config=/.exec(html);
  assert.ok(match, "O painel precisa estar disponível.");
  const status = async () => {
    const res = await fetch(base + "/control/status", { headers: { "X-Control-Token": JSON.parse(match[1]) } });
    assert.equal(res.status, 200);
    return res.json();
  };
  const idle = await status();
  assert.ok(idle.authenticated && !idle.request, "Execute sem outra chamada ativa e com o Muse autenticado.");
  const marker = "BRIDGE_RETRY_OK_" + Date.now().toString(36);
  const body = {
    model: "muse-web", stream: true,
    messages: [
      { role: "system", content: "Para esta verificação, a resposta final deve ser exatamente " + marker + ". Não execute ferramentas." },
      { role: "user", content: "Responda com o código definido nas instruções do cliente." },
    ],
    tools: [{ type: "function", function: { name: "noop", description: "Operação de teste sem efeito.", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
  };
  const hash = createHash("sha256").update(JSON.stringify({ messages: body.messages, tools: body.tools })).digest("hex").slice(0, 12);
  const post = (stream, signal) => fetch(base + "/v1/chat/completions", {
    method: "POST", signal,
    headers: { Authorization: "Bearer " + config.provider.muse.options.apiKey, "Content-Type": "application/json", "X-Muse-Session-Id": marker },
    body: JSON.stringify({ ...body, stream }),
  });
  const until = async (condition, milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("O estado esperado da chamada não foi atingido.");
  };
  const cancelled = new AbortController();
  const first = post(true, cancelled.signal).then((res) => res.text());
  first.catch(() => {});
  try {
    await until(async () => {
      const s = await status();
      return s.request === hash && s.pending?.phase === "waiting";
    }, 45000);
  } finally {
    cancelled.abort();
  }
  await assert.rejects(first, { name: "AbortError" });
  await until(async () => !(await status()).request, 5000);
  const resumed = await post(false, AbortSignal.timeout(60000));
  assert.equal(resumed.status, 200);
  const answer = await resumed.json();
  assert.equal(answer.choices[0].message.content.trim(), marker);
  const retry = await post(false, AbortSignal.timeout(5000));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).id, answer.id);
  const script = [
    'import {chromium} from "playwright-core";',
    'const browser=await chromium.connectOverCDP("http://127.0.0.1:9223",{headers:{Origin:"http://localhost"}});',
    'const page=browser.contexts()[0].pages().find(p=>p.url().startsWith("https://muse.ai"));',
    'console.log(JSON.stringify({users:await page.locator("[data-message-id][data-message-role=user]").count()}));',
    'process.exit(0);',
  ].join("\n");
  const result = await promisify(execFile)("docker", ["compose", "exec", "-T", "muse-bridge", "node", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  assert.equal(JSON.parse(result.stdout.trim()).users, 1, "O cancelamento e as repetições devem manter um único envio.");
  const thread = JSON.parse((await promisify(execFile)("docker", ["compose", "exec", "-T", "muse-bridge", "node", "--input-type=module", "-e",
    'import {readFile} from "node:fs/promises";const states=JSON.parse(await readFile("/data/conversations.json","utf8"));console.log(JSON.stringify(Object.fromEntries(Object.entries(states).map(([id,s])=>[id,s.url]))));'
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)) })).stdout);
  assert.match(thread[marker], /\/thread\/(?!new$)/);
  const second = await fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer " + config.provider.muse.options.apiKey, "Content-Type": "application/json", "X-Muse-Session-Id": marker + "_B" },
    body: JSON.stringify({ model: "muse-web", messages: [{ role: "user", content: "Responda somente SEGUNDA_OK." }] }), signal: AbortSignal.timeout(60000),
  });
  assert.equal(second.status, 200);
  const secondAnswer = await second.json();
  assert.match(secondAnswer.choices[0].message.content, /SEGUNDA_OK/);
  await promisify(execFile)("docker", ["compose", "restart", "muse-bridge"], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
  await until(async () => {
    try {
      const html = await (await fetch(base + "/")).text();
      const token = JSON.parse(html.match(/const token=("[^"\\]*(?:\\.[^"\\]*)*");const config=/)[1]);
      const current = await (await fetch(base + "/control/status", { headers: { "X-Control-Token": token } })).json();
      return current.authenticated;
    } catch { return false; }
  }, 45000);
  body.messages.push(answer.choices[0].message, { role: "user", content: "Repita o mesmo código de verificação." });
  const back = await post(false, AbortSignal.timeout(60000));
  assert.equal(back.status, 200);
  assert.equal((await back.json()).choices[0].message.content.trim(), marker);
  const mapping = JSON.parse((await promisify(execFile)("docker", ["compose", "exec", "-T", "muse-bridge", "node", "--input-type=module", "-e",
    'import {readFile} from "node:fs/promises";const states=JSON.parse(await readFile("/data/conversations.json","utf8"));console.log(JSON.stringify(Object.fromEntries(Object.entries(states).map(([id,s])=>[id,s.url]))));'
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)) })).stdout);
  assert.equal(mapping[marker], thread[marker], "Voltar à sessão A precisa reutilizar a mesma conversa do Muse.");
  assert.notEqual(mapping[marker], mapping[marker + "_B"], "Sessões distintas precisam ter conversas distintas.");

});

test("delivery failures are retryable but rate limits stay preserved", () => {
  for (const text of ["Delivery not confirmed", "Message failed to send", "Falha ao enviar"]) assert.ok(isDeliveryError(text), text);
  for (const text of ["Rate limit exceeded", "Usage limit reached", "Message is too long"]) assert.equal(isDeliveryError(text), false, text);
});

test("fitHistory keeps system rules and the recent turns, starting at a user message", () => {
  const messages = [
    { role: "system", content: "regras" },
    { role: "user", content: "a".repeat(500) }, { role: "assistant", content: "", tool_calls: [{ id: "1" }] }, { role: "tool", content: "b".repeat(500), tool_call_id: "1" },
    { role: "user", content: "pedido atual" }, { role: "assistant", content: "", tool_calls: [{ id: "2" }] }, { role: "tool", content: "resultado", tool_call_id: "2" },
  ];
  const all = fitHistory(messages, 100000);
  assert.equal(all.omitted, 0);
  assert.equal(all.messages.length, messages.length);
  const cut = fitHistory(messages, 400);
  assert.equal(cut.messages[0].role, "system");
  assert.equal(cut.messages[1].content, "pedido atual");
  assert.equal(cut.omitted, 3);
  // sem caber nada, o último pedido do usuário continua presente
  assert.equal(fitHistory(messages, 1).messages.at(1).content, "pedido atual");
});

test("a thread rotates only when it has an address and passed a limit", () => {
  assert.equal(needsRotation({ url: "https://muse.ai/thread/x", threadChars: 400000 }, 300000, 40), true);
  assert.equal(needsRotation({ url: "https://muse.ai/thread/x", turns: 40 }, 300000, 40), true);
  assert.equal(needsRotation({ url: "https://muse.ai/thread/x", threadChars: 10, turns: 3 }, 300000, 40), false);
  assert.equal(needsRotation({ threadChars: 999999 }, 300000, 40), false);
});
