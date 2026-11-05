// Gateway Anthropic (/v1/messages) -> ponte OpenAI-compatível (/v1/chat/completions).
// Sem dependências. Node >= 18.
//
//   UPSTREAM_URL   padrão http://127.0.0.1:4337/v1   (ponte DeepSeek)
//   UPSTREAM_KEY   chave da ponte (obrigatória)
//   UPSTREAM_MODEL padrão deepseek-web
//   GATEWAY_KEY    se definida, exige x-api-key / Authorization Bearer igual
//   GATEWAY_PORT   padrão 4350 ; GATEWAY_HOST padrão 127.0.0.1
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const UPSTREAM_URL = (process.env.UPSTREAM_URL || "http://127.0.0.1:4337/v1").replace(/\/$/, "");
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || "";
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || "deepseek-web";
const GATEWAY_KEY = process.env.GATEWAY_KEY || "";
const PORT = Number(process.env.GATEWAY_PORT || 4350);
const HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 450000);
// A ponte limita o prompt (~100k chars). O Claude Code manda >100k só em instruções e ferramentas, então encurtamos.
// BUDGET = máximo de caracteres para prompt de sistema + catálogo de ferramentas (o resto fica para a conversa).
const BUDGET = Number(process.env.GATEWAY_BUDGET || 55000);
const CORE_TOOLS = new Set((process.env.GATEWAY_CORE_TOOLS || "Read,Write,Edit,MultiEdit,Bash,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task,Agent,NotebookEdit,Skill").split(","));
// Níveis tentados em ordem até caber no BUDGET.
const LEVELS = [
  { sys: 15000, tool: 300, prop: 100, mcp: true },
  { sys: 10000, tool: 150, prop: 50, mcp: true },
  { sys: 8000, tool: 120, prop: 40, mcp: false },
  { sys: 6000, tool: 80, prop: 0, mcp: false, core: true },
];
if (!UPSTREAM_KEY) { console.error("Defina UPSTREAM_KEY."); process.exit(1); }

const sha = (s) => createHash("sha256").update(s).digest("hex");
const text = (c) => typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b?.type === "text" ? b.text : "").join("") : "");
const estimate = (s) => Math.max(1, Math.ceil(String(s).length / 4));

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : s);

function slimSchema(node, propMax) {
  if (Array.isArray(node)) return node.map((n) => slimSchema(n, propMax));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "description") { if (propMax > 0) out[k] = clip(v, propMax); } else out[k] = slimSchema(v, propMax);
  }
  return out;
}

function buildTools(tools, lv) {
  return tools
    .filter((t) => (lv.mcp || !String(t.name).startsWith("mcp__")) && (!lv.core || CORE_TOOLS.has(t.name)))
    .map((t) => ({ type: "function", function: { name: t.name, description: clip(t.description || "", lv.tool), parameters: slimSchema(t.input_schema, lv.prop) || { type: "object", properties: {} } } }));
}

// Escolhe o primeiro nível cujo (sistema + ferramentas) cabe no BUDGET; o último vale de qualquer jeito.
function fitPrompt(body) {
  const system = text(body.system);
  let pick;
  for (const lv of LEVELS) {
    const tools = buildTools(body.tools || [], lv);
    pick = { system: clip(system, lv.sys), tools };
    if (pick.system.length + JSON.stringify(tools).length <= BUDGET) break;
  }
  return pick;
}

// ---- Anthropic -> OpenAI -------------------------------------------------
export function toOpenAI(body) {
  const messages = [];
  const { system, tools } = fitPrompt(body);
  if (system) messages.push({ role: "system", content: system });
  for (const m of body.messages || []) {
    if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg = { role: "assistant", content: blocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
    } else {
      let pending = "";
      const flush = () => { if (pending) { messages.push({ role: "user", content: pending }); pending = ""; } };
      for (const b of blocks) {
        if (b.type === "tool_result") {
          flush();
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: text(b.content) || (b.is_error ? "erro" : "") });
        } else if (b.type === "text") pending += b.text;
        else if (b.type === "image") pending += "[imagem omitida]";
      }
      flush();
    }
  }
  const out = { model: UPSTREAM_MODEL, messages, stream: false };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (tools.length) {
    out.tools = tools;
    const tc = body.tool_choice;
    if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc?.type === "none") out.tool_choice = "none";
  }
  return out;
}

// Com ferramentas, o modelo às vezes devolve o protocolo cru da ponte: {"type":"final","text":"..."}.
export function unwrapFinal(t) {
  const s = String(t).trim();
  try { const o = JSON.parse(s); if (o && o.type === "final" && typeof o.text === "string") return o.text; } catch { /* pode ser JSON malformado: tenta por padrão */ }
  // o modelo costuma esquecer de escapar aspas internas, então o JSON.parse falha
  const m = s.match(/^\{\s*"type"\s*:\s*"final"\s*,\s*"text"\s*:\s*"([\s\S]*)"\s*\}$/);
  return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : t;
}

// ---- OpenAI -> Anthropic -------------------------------------------------
export function fromOpenAI(res, model) {
  const choice = res.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: unwrapFinal(msg.content) });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || "{}"); } catch { /* argumentos inválidos: envia vazio */ }
    content.push({ type: "tool_use", id: c.id || `toolu_${randomBytes(10).toString("hex")}`, name: c.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const stop = msg.tool_calls?.length ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
  return {
    id: `msg_${randomBytes(12).toString("hex")}`, type: "message", role: "assistant", model, content,
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? estimate(JSON.stringify(content)) },
  };
}

// ---- SSE -----------------------------------------------------------------
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

function streamMessage(res, message) {
  message.content.forEach((b, index) => {
    if (b.type === "text") {
      sse(res, "content_block_start", { index, content_block: { type: "text", text: "" } });
      if (b.text) sse(res, "content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      sse(res, "content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      sse(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    sse(res, "content_block_stop", { index });
  });
  sse(res, "message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  sse(res, "message_stop", {});
  res.end();
}

// ---- HTTP ----------------------------------------------------------------
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const err = (res, status, message, type = "api_error") => json(res, status, { type: "error", error: { type, message } });

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 20e6) throw new Error("corpo grande demais"); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

// A ponte guarda uma conversa por x-opencode-session-id: derivamos um id estável do início da conversa.
function sessionId(body) {
  const first = (body.messages || []).find((m) => m.role === "user");
  return `gw-${sha(text(body.system).slice(0, 2000) + "\n" + text(first?.content)).slice(0, 24)}`;
}

async function handleMessages(req, res) {
  const body = await readBody(req);
  const model = body.model || UPSTREAM_MODEL;
  const stream = body.stream === true;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  let ping;
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    sse(res, "message_start", { message: { id: `msg_${randomBytes(12).toString("hex")}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimate(JSON.stringify(body.messages)), output_tokens: 1 } } });
    ping = setInterval(() => sse(res, "ping", {}), 10000);
  }
  try {
    const payload = toOpenAI(body);
    console.log(`[${new Date().toISOString()}] /v1/messages ${JSON.stringify(payload).length} chars, ${payload.tools?.length || 0} ferramentas`);
    const up = await fetch(`${UPSTREAM_URL}/chat/completions`, {
      method: "POST", signal: abort.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${UPSTREAM_KEY}`, "x-opencode-session-id": sessionId(body) },
      body: JSON.stringify(payload),
    });
    const data = await up.json().catch(() => ({}));
    if (!up.ok) throw Object.assign(new Error(data?.error?.message || `ponte respondeu ${up.status}`), { status: up.status });
    const message = fromOpenAI(data, model);
    if (stream) streamMessage(res, message); else json(res, 200, message);
  } catch (e) {
    const status = e.name === "AbortError" ? 504 : (e.status >= 400 && e.status < 600 ? e.status : 502);
    if (stream) { sse(res, "error", { error: { type: "api_error", message: e.message } }); res.end(); }
    else err(res, status, e.message);
  } finally { clearTimeout(timer); clearInterval(ping); }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    const key = req.headers["x-api-key"] || req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (GATEWAY_KEY && !safeEqual(key, GATEWAY_KEY)) return err(res, 401, "chave inválida", "authentication_error");
    if (req.method === "POST" && url.pathname === "/v1/messages") return await handleMessages(req, res);
    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      const b = await readBody(req);
      return json(res, 200, { input_tokens: estimate(JSON.stringify([b.system, b.messages, b.tools])) });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, { data: [{ type: "model", id: UPSTREAM_MODEL, display_name: UPSTREAM_MODEL }], has_more: false });
    }
    err(res, 404, "rota não encontrada", "not_found_error");
  } catch (e) { if (!res.headersSent) err(res, 400, e.message, "invalid_request_error"); else res.end(); }
});

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  server.listen(PORT, HOST, () => console.log(`gateway em http://${HOST}:${PORT} -> ${UPSTREAM_URL} (${UPSTREAM_MODEL})`));
}
