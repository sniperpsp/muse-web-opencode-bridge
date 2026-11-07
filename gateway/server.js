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
import { execFile } from "node:child_process";

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
  { sys: Infinity, tool: Infinity, prop: Infinity, mcp: true }, // sem cortes: só serve se couber no BUDGET
  { sys: 15000, tool: 300, prop: 100, mcp: true },
  { sys: 10000, tool: 150, prop: 50, mcp: true },
  { sys: 8000, tool: 120, prop: 40, mcp: false },
  { sys: 6000, tool: 80, prop: 0, mcp: false, core: true },
];
// BACKENDS (JSON): [{"name":"deepseek","url":"http://127.0.0.1:4337/v1","key":"...","model":"deepseek-web","maxChars":240000}, ...]
// Tentados em ordem; pula quem não comporta o prompt ou falhou há pouco; troca para o próximo em caso de erro.
const BACKENDS = process.env.BACKENDS ? JSON.parse(process.env.BACKENDS) : [{ name: "default", url: UPSTREAM_URL, key: UPSTREAM_KEY, model: UPSTREAM_MODEL, maxChars: 240000 }];
// ROUTES (JSON), dois formatos:
//  por modelo:  {"haiku":["chatgpt","muse"],"default":["deepseek","muse","chatgpt"]}  (a chave é um trecho do nome do modelo pedido)
//  por demanda: {"tiers":[{"max":60000,"chain":["deepseek","muse"]},{"chain":["deepseek","muse","chatgpt","gemini"]}]}
//    "demanda" = tamanho (chars) da conversa, sem sistema/ferramentas; vence a primeira faixa cujo max comporta (a última não tem max).
//    Dentro de uma sessão a conversa só cresce, então ela sobe de faixa e nunca volta para uma ponte menor.
const ROUTES = process.env.ROUTES ? JSON.parse(process.env.ROUTES) : {};
export const demandOf = (body) => JSON.stringify(body?.messages || []).length;
export function chainFor(model, backends = BACKENDS, routes = ROUTES, demand = 0) {
  let names;
  if (Array.isArray(routes.tiers)) names = (routes.tiers.find((t) => t.max === undefined || demand <= t.max) || routes.tiers.at(-1))?.chain;
  else {
    const key = Object.keys(routes).find((k) => k !== "default" && String(model).toLowerCase().includes(k.toLowerCase()));
    names = routes[key] || routes.default;
  }
  if (!names) return backends;
  // um nome na cadeia vale para a ponte e para todas as suas réplicas (campo "group"), na ordem em que estão em BACKENDS
  return [...new Set(names.flatMap((n) => backends.filter((b) => b.name === n || b.group === n)))];
}
// Réplicas do mesmo grupo: a menos ocupada primeiro; entre iguais, a que já está ligada (evita esperar a subida do container).
const running = new Set();
setInterval(async () => { const out = await docker("ps", "--format", "{{.Names}}"); if (out) { running.clear(); out.split("\n").forEach((n) => running.add(n)); } }, 10000).unref();
export function orderChain(chain, load = () => 0, isUp = () => true, cooling = () => false) {
  const seen = [];
  const rank = new Map();
  chain.forEach((b) => { const g = b.group || b.name; if (!rank.has(g)) rank.set(g, rank.size); });
  const sorted = [...chain].sort((a, b) => (rank.get(a.group || a.name) - rank.get(b.group || b.name)) || (load(a) - load(b)) || (Number(isUp(b)) - Number(isUp(a))) || (chain.indexOf(a) - chain.indexOf(b)));
  // as que estão em pausa por falha recente ficam por último (só entram se as demais não resolverem)
  return [...sorted.filter((b) => !cooling(b)), ...sorted.filter((b) => cooling(b))];
}
const FIX_RETRIES = Number(process.env.GATEWAY_FIX_RETRIES || 2);
const COOLDOWN_MS = Number(process.env.GATEWAY_COOLDOWN_MS || 60000);
const downUntil = new Map();

// Liga/desliga sob demanda: backend com "container" é iniciado (docker start) quando um pedido o escolhe e parado após
// IDLE_MS sem uso. Só para o que o próprio gateway ligou (nunca derruba container que já estava de pé, p.ex. usado pelo OpenCode).
const IDLE_MS = Number(process.env.GATEWAY_IDLE_MS || 600000);
const WARM_MS = Number(process.env.GATEWAY_WARM_MS || 15000);
const startedByUs = new Set();
const lastUse = new Map();
const inflight = new Map();
const starting = new Map();
const startedAt = new Map();
const docker = (...args) => new Promise((resolve) => execFile("docker", args, { timeout: 60000 }, (e, out) => resolve(e ? "" : String(out).trim())));
export const isWarming = (msg, code = "") => /reconnecting|browser_/i.test(code) || /reconect|carregando|n[aã]o ficou pronta|indispon[ií]vel|ainda n[aã]o/i.test(msg || "");
async function ensureUp(b) {
  if (!b.container) return;
  lastUse.set(b.name, Date.now());
  if (starting.has(b.name)) { await starting.get(b.name); return; }
  if ((await docker("inspect", "-f", "{{.State.Running}}", b.container)) === "true") return;
  if (!starting.has(b.name)) {
    starting.set(b.name, (async () => {
      console.log(`[${new Date().toISOString()}] ligando ${b.container}`);
      await docker("start", b.container);
      startedByUs.add(b.name);
      for (let i = 0; i < 45; i++) {
        const r = await fetch(`${b.url.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${b.key}` }, signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (r?.ok) break;
        await new Promise((r2) => setTimeout(r2, 2000));
      }
      await new Promise((r2) => setTimeout(r2, WARM_MS)); // o navegador da ponte ainda precisa abrir a página
      startedAt.set(b.name, Date.now());
    })().finally(() => starting.delete(b.name)));
  }
  await starting.get(b.name);
}
setInterval(async () => {
  for (const b of BACKENDS) {
    if (!b.container || !startedByUs.has(b.name) || inflight.get(b.name) > 0) continue;
    if (Date.now() - (lastUse.get(b.name) || 0) < IDLE_MS) continue;
    console.log(`[${new Date().toISOString()}] desligando ${b.container} (ocioso)`);
    await docker("stop", b.container);
    startedByUs.delete(b.name);
  }
}, 60000).unref();
if (!BACKENDS.length || BACKENDS.some((b) => !b.key)) { console.error("Defina UPSTREAM_KEY (ou BACKENDS com key em todos)."); process.exit(1); }

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
function fitPrompt(body, budget = BUDGET) {
  const system = text(body.system);
  let pick;
  for (const lv of LEVELS) {
    const tools = buildTools(body.tools || [], lv);
    pick = { system: clip(system, lv.sys), tools };
    if (pick.system.length + JSON.stringify(tools).length <= budget) break;
  }
  return pick;
}

// ---- Anthropic -> OpenAI -------------------------------------------------
// Histórico grande demais para a ponte: 1) corta resultados de ferramenta e textos longos das mensagens antigas (mantém as últimas KEEP intactas);
// 2) se ainda não couber, descarta as mensagens mais antigas (preserva a 1ª, que é a tarefa) e tira tool_result órfão.
const KEEP = 8;
const clipStr = (t, n) => (String(t).length > n ? `${String(t).slice(0, n)}\n[... ${String(t).length - n} chars omitidos pelo gateway ...]` : t);
function clipMessage(m, n) {
  if (typeof m.content === "string") return { ...m, content: clipStr(m.content, n * 3) };
  if (!Array.isArray(m.content)) return m;
  return { ...m, content: m.content.map((b) => {
    if (b.type === "tool_result") return { ...b, content: typeof b.content === "string" ? clipStr(b.content, n) : Array.isArray(b.content) ? b.content.map((c) => (c.type === "text" ? { ...c, text: clipStr(c.text, n) } : c)) : b.content };
    if (b.type === "text") return { ...b, text: clipStr(b.text, n * 3) };
    return b;
  }) };
}
export function compactMessages(messages = [], limit = Infinity) {
  const size = (ms) => JSON.stringify(ms).length;
  if (size(messages) <= limit) return messages;
  const head = Math.max(0, messages.length - KEEP);
  for (const n of [2000, 800, 300]) {
    const ms = messages.map((m, i) => (i === 0 || i >= head ? m : clipMessage(m, n)));
    if (size(ms) <= limit) return ms;
  }
  let ms = messages.map((m, i) => (i === 0 || i >= head ? m : clipMessage(m, 300)));
  let drop = 1;
  const build = () => {
    const kept = [ms[0], ...ms.slice(1 + drop)];
    const ids = new Set(kept.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").map((b) => b.id) : [])));
    return kept.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b.type !== "tool_result" || ids.has(b.tool_use_id)) } : m)).filter((m) => typeof m.content === "string" || m.content?.length);
  };
  while (drop < ms.length - 2 && size(build()) > limit) drop++;
  const out = build();
  out.splice(1, 0, { role: "user", content: `(O gateway omitiu as ${drop} mensagens mais antigas desta sessão para caber no limite da ponte; continue a partir das mensagens abaixo.)` });
  return out;
}
export function toOpenAI(body, budget = BUDGET, model = UPSTREAM_MODEL) {
  const messages = [];
  const { system, tools } = fitPrompt(body, budget);
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
  const out = { model, messages, stream: false };
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
// O modelo web às vezes escreve a chamada de ferramenta como texto em formato próprio, ex.: {"type":"grep","pattern":"x"} ou
// {"name":"grep","arguments":{...}}. Só vira tool_use se o nome bater com uma ferramenta que o cliente declarou; senão segue como texto.
const TOOL_ALIAS = { shell: "bash", sh: "bash", terminal: "bash", command: "bash", cmd: "bash", run: "bash", exec: "bash", execute: "bash", run_command: "bash",
  read_file: "read", cat: "read", view: "read", write_file: "write", create_file: "write", edit_file: "edit", search: "grep", ripgrep: "grep", rg: "grep", find: "glob", ls: "list", list_files: "list" };
// Acha o último objeto JSON do texto (ignora lixo antes, como "json" + numeração de linhas do bloco de código) e devolve { obj, pre }.
function extractJson(text) {
  let s = String(text).trim().replace(/```(?:json)?/gi, "").trim();
  const open = [...s].map((c, i) => (c === "{" ? i : -1)).filter((i) => i >= 0);
  for (const i of open) { // do mais externo para o mais interno: o primeiro que fecha o texto inteiro até o último "}"
    const end = s.lastIndexOf("}");
    if (end < i) break;
    try { const obj = JSON.parse(s.slice(i, end + 1)); return { obj, pre: s.slice(0, i) }; } catch { /* tenta o próximo "{" */ }
  }
  return null;
}
// O modelo web às vezes escreve a chamada de ferramenta como texto em formato próprio, ex.: {"type":"grep","pattern":"x"},
// {"name":"grep","arguments":{...}} ou {"type":"tool_call","name":"shell",...}. Só vira tool_use se o nome (ou um apelido conhecido) bater
// com uma ferramenta que o cliente declarou; senão segue como texto. Devolve { name, input, pre } (pre = texto útil antes do JSON).
export function salvageToolCall(text, toolNames = []) {
  if (!toolNames.length) return null;
  const ex = extractJson(text);
  if (!ex || !ex.obj || typeof ex.obj !== "object" || Array.isArray(ex.obj)) return null;
  const o = ex.obj;
  const find = (n) => {
    const k = String(n).toLowerCase();
    return toolNames.find((t) => t.toLowerCase() === k) || (TOOL_ALIAS[k] && toolNames.find((t) => t.toLowerCase() === TOOL_ALIAS[k]));
  };
  // texto antes do JSON sem o cabeçalho "json" nem as linhas só de número
  const pre = ex.pre.split("\n").filter((l) => !/^\s*(json|\d+)\s*$/i.test(l)).join("\n").trim();
  const done = (name, input) => {
    if (name.toLowerCase() === "bash" && input && input.command === undefined) { const c = input.cmd ?? input.script; if (c !== undefined) { input = { ...input, command: c }; delete input.cmd; delete input.script; } }
    return { name, input, pre };
  };
  const named = find(o.name ?? o.tool ?? o.function);
  if (named && (o.arguments || o.input || o.args || o.parameters) && (o.type === undefined || /tool|call|use/i.test(String(o.type)))) {
    let a = o.arguments ?? o.input ?? o.args ?? o.parameters;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { return null; } }
    return done(named, a && typeof a === "object" ? a : {});
  }
  const byType = typeof o.type === "string" && o.type !== "final" ? find(o.type) : undefined;
  if (byType) { const { type, ...rest } = o; return done(byType, rest); }
  return null;
}
// ---- Guardrails: valida a resposta da ponte antes de devolver ao cliente ----
// Conserta o que dá (lixo de bloco de código, chamada de ferramenta escrita como texto, apelido de ferramenta, campo "description" faltando)
// e devolve { data, problem }: com "problem" o gateway reenvia com um aviso corretivo e, se persistir, troca de ponte.
const NOISE_RE = /^\s*(?:json|javascript|js|bash|sh|text|python)\s*\n(?:\s*\d+\s*\n){2,}/i;
const LEAK_RE = /"type"\s*:\s*"(?:tool_call|tool_use|final)"|"(?:arguments|parameters)"\s*:\s*[{"]|^\s*\{\s*"(?:name|tool)"\s*:/;
export function checkResponse(res, tools = []) {
  const data = JSON.parse(JSON.stringify(res || {}));
  const msg = data.choices?.[0]?.message;
  if (!msg) return { data, problem: "resposta sem mensagem" };
  const names = tools.map((t) => t.name);
  const schema = (n) => tools.find((t) => t.name === n)?.input_schema || {};
  if (typeof msg.content === "string") msg.content = msg.content.replace(NOISE_RE, "");
  if (!msg.tool_calls?.length && msg.content && names.length) {
    const sv = salvageToolCall(msg.content, names);
    if (sv) {
      msg.tool_calls = [{ id: `call_${randomBytes(8).toString("hex")}`, type: "function", function: { name: sv.name, arguments: JSON.stringify(sv.input) } }];
      msg.content = sv.pre || null;
    }
  }
  if (msg.tool_calls?.length) {
    for (const c of msg.tool_calls) {
      const raw = c.function?.name;
      const k = String(raw).toLowerCase();
      const real = names.find((n) => n.toLowerCase() === k) || (TOOL_ALIAS[k] && names.find((n) => n.toLowerCase() === TOOL_ALIAS[k]));
      if (names.length && !real) return { data, problem: `ferramenta desconhecida "${raw}"` };
      if (real) c.function.name = real;
      let args;
      try { args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function.arguments || {}; } catch { return { data, problem: `argumentos de ${c.function.name} não são JSON válido` }; }
      if (args === null || typeof args !== "object" || Array.isArray(args)) return { data, problem: `argumentos de ${c.function.name} inválidos` };
      if (c.function.name.toLowerCase() === "bash" && args.command === undefined && (args.cmd ?? args.script) !== undefined) { args.command = args.cmd ?? args.script; delete args.cmd; delete args.script; }
      const missing = (schema(c.function.name).required || []).filter((f) => args[f] === undefined || args[f] === null || args[f] === "");
      for (const f of [...missing]) {
        if (f === "description" && typeof args.command === "string") { args.description = args.command.slice(0, 60); missing.splice(missing.indexOf(f), 1); }
      }
      if (missing.length) return { data, problem: `${c.function.name} sem os campos obrigatórios: ${missing.join(", ")}` };
      c.function.arguments = JSON.stringify(args);
    }
    return { data, problem: null };
  }
  const text = String(msg.content || "").trim();
  if (!text) return { data, problem: "resposta vazia" };
  if (unwrapFinal(text) === text && LEAK_RE.test(text)) return { data, problem: "chamada de ferramenta em formato inválido" };
  return { data, problem: null };
}
export function fromOpenAI(res, model, toolNames = []) {
  const choice = res.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  const salvaged = !msg.tool_calls?.length && msg.content ? salvageToolCall(msg.content, toolNames) : null;
  if (salvaged) {
    console.log(`[${new Date().toISOString()}] chamada de ferramenta recuperada do texto: ${salvaged.name}`);
    if (salvaged.pre) content.push({ type: "text", text: salvaged.pre });
    content.push({ type: "tool_use", id: `toolu_${randomBytes(10).toString("hex")}`, name: salvaged.name, input: salvaged.input });
  } else if (msg.content) content.push({ type: "text", text: unwrapFinal(msg.content) });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || "{}"); } catch { /* argumentos inválidos: envia vazio */ }
    content.push({ type: "tool_use", id: c.id || `toolu_${randomBytes(10).toString("hex")}`, name: c.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const stop = msg.tool_calls?.length || salvaged ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
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
    let message, last;
    const now = Date.now();
    const chain = chainFor(body.model, BACKENDS, ROUTES, demandOf(body));
    const order = orderChain(chain, (x) => inflight.get(x.name) || 0, (x) => !x.container || running.has(x.container), (x) => (downUntil.get(x.name) || 0) > now);
    let sizeErr;
    for (const [i, b] of order.entries()) {
      // cada ponte tem uma aba só: se já há pedidos demais nela e ainda há outra opção, passa para a próxima
      if ((inflight.get(b.name) || 0) >= (b.concurrency ?? 1) && order.slice(i + 1).some((o) => (inflight.get(o.name) || 0) < (o.concurrency ?? 1))) continue;
      // deixa ~40k para a conversa; mínimo de 20k para sistema + ferramentas
      const budget = Math.min(BUDGET, Math.max(20000, b.maxChars - 40000));
      const build = (extra) => {
        const base = extra ? { ...body, messages: [...(body.messages || []), extra] } : body;
        let pl = toOpenAI(base, budget, b.model);
        if (JSON.stringify(pl).length > b.maxChars) {
          const fixed = JSON.stringify(toOpenAI({ ...base, messages: [{ role: "user", content: "." }] }, budget, b.model)).length;
          const before = JSON.stringify(pl).length;
          pl = toOpenAI({ ...base, messages: compactMessages(base.messages, Math.max(20000, b.maxChars - fixed - 10000)) }, budget, b.model);
          console.log(`[${new Date().toISOString()}] histórico compactado para ${b.name}: ${before} -> ${JSON.stringify(pl).length} chars`);
        }
        return pl;
      };
      let payload = build();
      const size = JSON.stringify(payload).length;
      if (size > b.maxChars) { sizeErr = sizeErr || new Error(`prompt de ${size} chars não cabe em ${b.name} (${b.maxChars})`); continue; }
      console.log(`[${new Date().toISOString()}] /v1/messages -> ${b.name}: ${size} chars, ${payload.tools?.length || 0} ferramentas`);
      try {
        inflight.set(b.name, (inflight.get(b.name) || 0) + 1);
        const t0 = Date.now();
        await ensureUp(b);
        const post = async (pl, sid) => {
          let up, data;
          for (let attempt = 0; ; attempt++) {
            up = await fetch(`${b.url.replace(/\/$/, "")}/chat/completions`, {
              method: "POST", signal: abort.signal,
              headers: { "content-type": "application/json", authorization: `Bearer ${b.key}`, "x-opencode-session-id": sid },
              body: JSON.stringify(pl),
            });
            data = await up.json().catch(() => ({}));
            // ponte recém-ligada ainda abrindo o navegador: espera e repete na mesma ponte
            if (up.status === 503 && attempt < 8 && (isWarming(data?.error?.message, data?.error?.code) || Date.now() - (startedAt.get(b.name) || 0) < 90000)) { await new Promise((r2) => setTimeout(r2, 8000)); continue; }
            break;
          }
          if (!up.ok) throw Object.assign(new Error(data?.error?.message || `${b.name} respondeu ${up.status}`), { status: up.status });
          return data;
        };
        let data = await post(payload, sessionId(body));
        let chk = checkResponse(data, body.tools || []);
        // resposta inválida (vazia, ferramenta inexistente, JSON quebrado...): reenvia com aviso, numa conversa nova da ponte, até FIX_RETRIES vezes
        for (let n = 1; chk.problem && n <= FIX_RETRIES; n++) {
          console.log(`[${new Date().toISOString()}] resposta inválida de ${b.name} (${chk.problem}); reenviando ${n}/${FIX_RETRIES}`);
          const nomes = (body.tools || []).map((t) => t.name).slice(0, 30).join(", ");
          const aviso = { role: "user", content: `[Aviso automático do gateway] Sua resposta anterior não pôde ser usada: ${chk.problem}. Responda de novo agora. Se precisa usar uma ferramenta, devolva SOMENTE a chamada de ferramenta no formato pedido, com um destes nomes exatos${nomes ? ` (${nomes})` : ""} e todos os campos obrigatórios. Se terminou, devolva SOMENTE o texto final.` };
          data = await post(build(aviso), `${sessionId(body)}-r${n}`);
          chk = checkResponse(data, body.tools || []);
        }
        if (chk.problem) throw Object.assign(new Error(`resposta inválida de ${b.name}: ${chk.problem}`), { noCooldown: true });
        message = fromOpenAI(chk.data, model, (payload.tools || []).map((t) => t.function?.name).filter(Boolean));
        console.log(`[${new Date().toISOString()}] ok ${b.name} em ${Math.round((Date.now() - t0) / 1000)}s`);
        break;
      } catch (e) {
        if (abort.signal.aborted) throw e; // cliente saiu ou estourou o tempo total
        console.log(`[${new Date().toISOString()}] ${b.name} falhou: ${e.message.slice(0, 120)}`);
        // ponte fora do ar (reinício/queda): pausa curta; falha da página/site: pausa longa; resposta inválida do modelo: sem pausa
        if (!e.noCooldown) downUntil.set(b.name, Date.now() + (/fetch failed|ECONNREFUSED|socket hang up/i.test(`${e.message} ${e.cause?.code || ""}`) ? 5000 : COOLDOWN_MS));
        // limite de requisições da conta (429): vale para todos os backends com o mesmo "shared" (ex.: todos os modelos NVIDIA)
        if (e.status === 429 && b.shared) BACKENDS.filter((x) => x.shared === b.shared).forEach((x) => downUntil.set(x.name, Date.now() + COOLDOWN_MS));
        last = e;
      } finally { inflight.set(b.name, Math.max(0, (inflight.get(b.name) || 1) - 1)); lastUse.set(b.name, Date.now()); }
    }
    if (!message) throw last || sizeErr || new Error("nenhuma ponte disponível");
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
