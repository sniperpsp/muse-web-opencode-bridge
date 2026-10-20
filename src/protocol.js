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

export function parseToolCall(text, tools = []) {
  const rawContent = /^<opencode_tool_call>\s*(\{[^\r\n]*\})\r?\n<<<MUSE_FILE_CONTENT_BEGIN>>>\r?\n([\s\S]*?)<<<MUSE_FILE_CONTENT_END>>>\s*<\/opencode_tool_call>$/i.exec(text.trim());
  if (rawContent) {
    try {
      const call = JSON.parse(rawContent[1]);
      const key = call?.name === "write" ? "content" : call?.name === "edit" ? "newString" : "";
      if (!key || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) return null;
      const requested = tools.some((tool) => tool?.type === "function" && tool.function?.name === call.name);
      if (!requested) return null;
      const content = rawContent[2].replace(/\r?\n$/, "");
      const fenced = /^````(?:text|html|jsx)?\r?\n([\s\S]*?)\r?\n````$/i.exec(content);
      call.arguments[key] = fenced ? fenced[1] : content;
      return { name: call.name, arguments: call.arguments };
    } catch {
      return null;
    }
  }
  const match = /<opencode_tool_call>\s*([\s\S]*?)\s*<\/opencode_tool_call>/i.exec(text);
  try {
    const call = JSON.parse(match ? match[1] : responseJson(text));
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
  return /^\s*(?:<opencode_tool_call>|\{[\s\S]*?"type"\s*:\s*"tool_call")/i.test(responseJson(text));
}

function responseJson(text) {
  return text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1");
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
