// Z.ai (chat.z.ai). Seletores confirmados no DOM logado em 2026-11-05.
export const DEFAULT_URL = "https://chat.z.ai/";
export const MESSAGE_UNIT_SELECTOR = ".chat-user, .chat-assistant";
export const MESSAGE_ID_ATTR = "data-bridge-id";
export function stampMessages([unitSelector, idAttr]) {
  const seen = {};
  document.querySelectorAll(unitSelector).forEach((el) => {
    const text = el.innerText || "";
    const key = `${text.slice(0, 200)}|${text.length}|${text.slice(-200)}`;
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    seen[hash] = (seen[hash] || 0) + 1;
    el.setAttribute(idAttr, `${(hash >>> 0).toString(36)}.${seen[hash]}:${el.classList.contains("chat-assistant") ? "assistant" : "user"}`);
  });
}
export function messageRole(id) { return (id || "").endsWith(":user") ? "user" : "assistant"; }
export function isAssistantMessageId(id) { return (id || "").endsWith(":assistant"); }
export const ASSISTANT_TEXT_SELECTOR = "#response-content-container .markdown-prose";
export const STREAMING_SELECTOR = "button:has(span[class*=\"size-3\"][class*=\"rounded-xs\"])";
export const CONVERSATION_PATH_RE = /^\/c\/[a-zA-Z0-9-]+$/;
export const LOGGED_OUT_BUTTON_NAME_RE = /^(log in|sign up|entrar)$/i;
export const LOGIN_FIELDS_SELECTOR = 'input[type="email"], input[type="password"], input[placeholder*="email" i]';
export const LOGIN_BUTTON_TEXT_RE = /^(log in|entrar)$/i;
export const LOGIN_SCREEN_TEXT_RE = /log in|sign in|entrar|verification code/i;
export const COMPOSER_SELECTOR = "textarea#chat-input";
export const GENERIC_COMPOSER_SELECTOR = 'textarea, [contenteditable="true"]';
export const SEND_BUTTON_NAME_RE = /send|enviar/i;
export const SEND_SELECTOR = "button#send-message-button";
export const MEDIA_SELECTOR = "#response-content-container img, #response-content-container a[download]";
// Esconde a caixa "Thought Process" (innerText ignora display:none) e o tour de boas-vindas que bloqueia cliques.
export const PAGE_CSS = ".thinking-chain-container, .driver-overlay, .driver-popover { display: none !important; pointer-events: none !important; }";
