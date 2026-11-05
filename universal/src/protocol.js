const MAX_FILE_BYTES = 12 * 1024 * 1024;

const AUDIO_MIME = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
};

function extensionFor(mimeType) {
  const known = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/webm": "webm",
  };
  return known[mimeType] || mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
}

function checkedFile(name, mimeType, buffer) {
  if (!buffer.length) throw new Error("O anexo está vazio.");
  if (buffer.length > MAX_FILE_BYTES) throw new Error("Cada anexo pode ter no máximo 12 MB.");
  if (!/^(image|audio|video)\/[a-z0-9.+-]+$/i.test(mimeType)) {
    throw new Error(`Tipo de anexo não aceito: ${mimeType || "desconhecido"}.`);
  }
  return { name: name.replace(/[^a-z0-9._-]/gi, "_").slice(0, 100), mimeType, buffer };
}

export function conversationMessages(messages) {
  return messages.filter((message) => !["system", "developer"].includes(message.role));
}

export function localTitle(messages) {
  if (!messages.some((message) => ["system", "developer"].includes(message.role)
    && parseContent(message.content).text.startsWith("You are a title generator."))) return null;
  // ponytail: titles use the first 50 characters; use a separate summarizer if semantic titles are needed.
  const text = parseContent(messages.findLast((message) => message.role === "user")?.content).text;
  return text.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ").slice(0, 50).trim() || "Conversa";
}

export function currentReply(messages, beforeMessageIds) {
  const previous = new Set(beforeMessageIds);
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  const user = messages[userIndex];
  if (!user?.id || previous.has(user.id)) return null;
  const replies = messages.slice(userIndex + 1).filter((message) => message.role === "assistant" && message.id && !previous.has(message.id));
  return {
    text: replies.map((message) => message.text.trim()).filter(Boolean).join("\n\n"),
    busy: replies.some((message) => message.busy),
  };
}

export function simpleGreeting(text) {
  const greeting = text.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)'|“([\s\S]*)”|‘([\s\S]*)’)$/, (_, ...quoted) =>
    quoted.find((part) => part !== undefined).trim());
  return /^(?:oi|olá|ola|bom dia|boa tarde|boa noite|hey|hi|hello)(?:\s*,\s*[\p{L}\p{M}][\p{L}\p{M}' -]{0,29})?[.!?]*$/iu.test(greeting)
    ? greeting
    : null;
}

function fromDataUrl(value, fallbackName) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match) throw new Error("Anexo remoto não aceito; envie a imagem ou áudio como data URL.");
  const mimeType = (match[1] || "application/octet-stream").toLowerCase();
  const buffer = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]));
  return checkedFile(`${fallbackName}.${extensionFor(mimeType)}`, mimeType, buffer);
}

function fromBase64(value, mimeType, fallbackName) {
  if (typeof value !== "string" || !/^[a-z0-9+/]*={0,2}$/i.test(value)) {
    throw new Error("O conteúdo do anexo não está em Base64 válido.");
  }
  return checkedFile(`${fallbackName}.${extensionFor(mimeType)}`, mimeType, Buffer.from(value, "base64"));
}

export function parseContent(content) {
  if (typeof content === "string") return { text: content, files: [] };
  if (!Array.isArray(content)) {
    if (content == null) return { text: "", files: [] };
    return { text: JSON.stringify(content), files: [] };
  }

  const texts = [];
  const files = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text") {
      if (typeof part.text === "string") texts.push(part.text);
    } else if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url !== "string") throw new Error("A imagem precisa usar image_url com data URL.");
      files.push(fromDataUrl(url, `imagem-${files.length + 1}`));
    } else if (part.type === "input_audio") {
      const format = String(part.input_audio?.format || "wav").toLowerCase();
      const mimeType = AUDIO_MIME[format];
      if (!mimeType) throw new Error(`Formato de áudio não aceito: ${format}.`);
      files.push(fromBase64(part.input_audio?.data, mimeType, `audio-${files.length + 1}`));
    } else if (part.type === "audio_url") {
      const url = typeof part.audio_url === "string" ? part.audio_url : part.audio_url?.url;
      if (typeof url !== "string") throw new Error("O áudio precisa usar data URL.");
      files.push(fromDataUrl(url, `audio-${files.length + 1}`));
    }
  }
  if (files.reduce((sum, file) => sum + file.buffer.length, 0) > MAX_FILE_BYTES * 2) {
    throw new Error("O total de anexos por mensagem pode ter no máximo 24 MB.");
  }
  return { text: texts.join("\n"), files };
}

export function transcriptDelta(before, after, prompt) {
  let tail;
  if (after.startsWith(before)) {
    tail = after.slice(before.length);
  } else {
    let common = 0;
    while (common < before.length && common < after.length && before[common] === after[common]) common++;
    tail = after.slice(common);
  }
  const promptAt = tail.lastIndexOf(prompt);
  if (promptAt >= 0) tail = tail.slice(promptAt + prompt.length);
  return tail.trim();
}

// O markdown do DeepSeek engole a tag de abertura; devolve ela quando só o fechamento sobrou.
function restoreOpenTag(text) {
  let t = text.trim();
  // O markdown bruto vem embrulhado no bloco ```json do DeepSeek; com conteúdo de arquivo, a cerca externa é tirada.
  if (/<<<MUSE_FILE_CONTENT_BEGIN>>>/.test(t)) t = t.replace(/^```[a-z]*[ \t]*\n/i, "").replace(/\n```$/, "").trim();
  return /<\/opencode_tool_call>$/i.test(t) && !/<opencode_tool_call>/i.test(t) ? `<opencode_tool_call>\n${t}` : t;
}

// O modelo às vezes escreve {"type":"edit",...} sem "name": o tipo é o nome da ferramenta.
function withName(call, tools) {
  if (call && typeof call === "object" && typeof call.name !== "string" && tools.some((tool) => tool?.function?.name === call.type)) { call.name = call.type; call.type = "tool_call"; }
  return call;
}

// Sintaxe nativa de ferramentas do DeepSeek (<｜DSML｜ invoke name="read"> ... parameter ...), que ele usa quando ignora o nosso JSON.
// As barras e espaços variam (｜, ｜｜, |), então o parser só exige "DSML" entre elas.
const DSML = String.raw`<[｜|\s]*DSML[｜|\s]*`;
const DSML_END = String.raw`<\/[｜|\s]*DSML[｜|\s]*`;
export function hasDsml(text) { return new RegExp(`${DSML}(?:function_)?calls?\\b|${DSML}invoke\\b`, "i").test(text); }

function parseDsml(text, tools) {
  const invoke = new RegExp(`${DSML}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)${DSML_END}invoke\\s*>`, "i").exec(text);
  if (!invoke || !tools.some((tool) => tool?.type === "function" && tool.function?.name === invoke[1])) return null;
  const args = {};
  const param = new RegExp(`${DSML}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)${DSML_END}parameter\\s*>`, "gi");
  for (const [, key, isString, raw] of invoke[2].matchAll(param)) {
    if (isString?.toLowerCase() === "false") { try { args[key] = JSON.parse(raw.trim()); continue; } catch { /* fica como texto */ } }
    args[key] = raw;
  }
  return { name: invoke[1], arguments: args };
}

export function parseToolCall(text, tools = []) {
  const dsml = hasDsml(text) ? parseDsml(text, tools) : null;
  if (dsml) return dsml;
  text = restoreOpenTag(text);
  const rawContent = /^<opencode_tool_call>\s*(\{[^\r\n]*\})\r?\n<<<MUSE_FILE_CONTENT_BEGIN>>>\r?\n([\s\S]*?)<<<MUSE_FILE_CONTENT_END>>>\s*<\/opencode_tool_call>$/i.exec(text.trim());
  if (rawContent) {
    try {
      const call = withName(JSON.parse(rawContent[1]), tools);
      const key = call?.name === "write" ? "content" : call?.name === "edit" ? "newString" : "";
      if (!key || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) return null;
      const requested = tools.some((tool) => tool?.type === "function" && tool.function?.name === call.name);
      if (!requested) return null;
      const content = rawContent[2].replace(/\r?\n$/, "");
      const fenced = /^````(?:text|html|jsx)?\r?\n([\s\S]*?)\r?\n````$/i.exec(content);
      const body = fenced ? fenced[1] : content;
      // Bloco vazio (o modelo pôs o texto no JSON) não pode apagar o valor já presente.
      if (body !== "" || typeof call.arguments[key] !== "string") call.arguments[key] = body;
      return { name: call.name, arguments: call.arguments };
    } catch {
      return null;
    }
  }
  const match = /<opencode_tool_call>\s*([\s\S]*?)\s*<\/opencode_tool_call>/i.exec(text);
  try {
    const call = withName(JSON.parse(match ? match[1] : responseJson(text)), tools);
    if (!match && call?.type !== "tool_call") return null;
    if (!call || typeof call !== "object") return null;
    if (typeof call.name !== "string" || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) return null;
    const requested = tools.some((tool) => tool?.type === "function" && tool.function?.name === call.name);
    return requested ? { name: call.name, arguments: call.arguments } : null;
  } catch {
    return null;
  }
}

export function looksLikeToolCall(text) {
  if (hasDsml(text)) return true;
  return /^\s*(?:<opencode_tool_call>|\{[\s\S]*?"type"\s*:\s*"tool_call"|\{\s*"type"\s*:\s*"[a-z_]+"\s*,\s*"arguments")/i.test(responseJson(text));
}

function responseJson(text) {
  // O DeepSeek às vezes deixa "</br>" ou texto solto depois do JSON; fica só o objeto, do primeiro "{" ao último "}".
  const unfenced = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1").replace(/(?:\s*<\/?br\s*\/?>)+\s*$/i, "");
  const trimmed = unfenced.trim();
  if (!trimmed.startsWith("{")) return unfenced;
  const end = trimmed.lastIndexOf("}");
  return end > 0 ? trimmed.slice(0, end + 1) : unfenced;
}

export function finalText(text) {
  try {
    const value = JSON.parse(responseJson(text));
    return value?.type === "final" && typeof value.text === "string" ? value.text : text;
  } catch { return text; }
}
export function checkPromptLength(prompt, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Limite de texto inválido.");
  if (prompt.length <= limit) return;
  throw Object.assign(new Error(`O texto final para o Muse tem ${prompt.length} caracteres; o limite local é ${limit}. Reduza a demanda, o histórico ou os resultados de ferramentas e envie até ${limit} caracteres no total, incluindo instruções e catálogo de ferramentas. Não repita a mesma requisição: ela não foi enviada ao Muse.`), {
    status: 400, code: "context_length_exceeded", param: "messages",
    limit_chars: limit, received_chars: prompt.length, retryable: false,
  });
}

export function isPromptSizeError(text) {
  return /(?:message|prompt|input|text)[\s\S]{0,100}(?:too (?:long|large)|exceeds? (?:the )?(?:maximum|character)|longer than)|(?:mensagem|texto|entrada)[\s\S]{0,100}(?:muito (?:long[ao]|grande)|excede.{0,30}(?:caracteres|tamanho))|maximum (?:prompt|message|input|text) length/i.test(text);
}

// O Muse avisa que a mensagem não chegou: reenviar é seguro, não há duplicação.
export function isDeliveryError(text) {
  return /delivery not confirmed|entrega n[ãa]o confirmada|falha (?:na|ao) (?:entrega|enviar)|failed to (?:send|deliver)/i.test(text);
}

// Mantém as instruções system/developer e as mensagens mais recentes que cabem no orçamento, começando num turno do usuário
// para não separar a chamada de ferramenta do seu resultado. A última mensagem do usuário nunca é descartada.
export function fitHistory(messages, budget) {
  const isHead = (message) => message.role === "system" || message.role === "developer";
  const head = messages.filter(isHead);
  const rest = messages.filter((message) => !isHead(message));
  const size = (message) => JSON.stringify(message).length;
  let used = head.reduce((total, message) => total + size(message), 0);
  let start = rest.length;
  while (start > 0 && used + size(rest[start - 1]) <= budget) used += size(rest[--start]);
  const lastUser = rest.findLastIndex((message) => message.role === "user");
  if (lastUser >= 0) {
    start = Math.min(start, lastUser);
    while (start < lastUser && rest[start].role !== "user") start++;
  }
  return { messages: [...head, ...rest.slice(start)], omitted: start };
}

// Encurta o miolo dos resultados de ferramenta (depois, das mensagens antigas) até as mensagens caberem no orçamento.
// Nunca mexe nas instruções system/developer; a última mensagem do usuário só é encurtada como último recurso.
export function capMessages(messages, budget) {
  const out = messages.map((message) => ({ ...message }));
  const total = () => out.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  const pick = (eligible) => {
    let index = -1;
    let longest = 2000;
    out.forEach((message, i) => {
      if (typeof message.content === "string" && message.content.length > longest && eligible(message, i)) { longest = message.content.length; index = i; }
    });
    return index;
  };
  const lastUser = out.findLastIndex((message) => message.role === "user");
  for (let guard = 0; guard < 500 && total() > budget; guard++) {
    let index = pick((message) => message.role === "tool");
    if (index < 0) index = pick((message, i) => message.role !== "system" && message.role !== "developer" && i !== lastUser);
    if (index < 0) index = pick((message) => message.role === "user"); // último recurso: pedido de compactação traz o histórico inteiro na última mensagem
    if (index < 0) break;
    const text = out[index].content;
    const keep = Math.max(1000, text.length - (total() - budget) - 400);
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    out[index].content = `${text.slice(0, head)}\n[... ${text.length - keep} caracteres omitidos para caber no limite ...]\n${text.slice(text.length - tail)}`;
  }
  return out;
}

// A conversa do Muse acumula texto na página; passando do limite, a ponte abre outra thread.
// O primeiro envio (instruções do cliente) é grande por natureza e não conta: vale só o crescimento depois dele.
export function needsRotation(conversation, maxChars, maxTurns) {
  const growth = (conversation.threadChars || 0) - (conversation.baseChars || 0);
  return Boolean(conversation.url) && (growth > maxChars || (conversation.turns || 0) >= maxTurns);
}


// O editor do chatgpt.com (ProseMirror) cria um parágrafo por linha e fica lento (~40 ms/linha: 500 linhas = 19 s, travava o Chromium).
// Texto sem quebras de linha entra em <1 s mesmo com 300k caracteres, então prompts longos vão numa linha só, com ⏎ no lugar das quebras.
export const MAX_COMPOSER_LINES = 120;
export function composerText(prompt) {
  if (prompt.split("\n").length <= MAX_COMPOSER_LINES) return prompt;
  return "(Neste texto, ⏎ representa uma quebra de linha.) " + prompt.replace(/\n{2,}/g, " ⏎⏎ ").replace(/\n/g, " ⏎ ");
}

// Roda dentro da página do DeepSeek (enviada como texto): não pode usar nada fora do corpo da função.
// O OpenCode exige o resumo de compactação com "## Seção" e "- item"; innerText perde esses marcadores.
export function toMarkdown(root) {
  const walk = (el) => {
    let out = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { out += n.textContent; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) out += `\n\n${"#".repeat(Number(tag[1]))} ${walk(n).trim()}\n\n`;
      else if (tag === "p") out += `\n\n${walk(n).trim()}\n\n`;
      else if (tag === "ul" || tag === "ol") { let i = 0; out += "\n"; for (const li of n.children) if (li.tagName === "LI") out += `${tag === "ol" ? `${++i}. ` : "- "}${walk(li).trim().replace(/\n+/g, " ")}\n`; out += "\n"; }
      else if (tag === "pre") out += `\n\n\`\`\`\n${(n.querySelector("code") || n).innerText.replace(/\n$/, "")}\n\`\`\`\n\n`;
      else if (tag === "code") out += `\`${n.textContent}\``;
      else if (tag === "strong" || tag === "b") out += `**${walk(n)}**`;
      else if (tag === "em" || tag === "i") out += `*${walk(n)}*`;
      else if (tag === "br") out += "\n";
      else if (tag !== "button" && tag !== "svg") out += walk(n);
    }
    return out;
  };
  return walk(root).replace(/\n{3,}/g, "\n\n").trim();
}
