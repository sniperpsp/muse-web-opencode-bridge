// Kimi (www.kimi.ai). Seletores confirmados no DOM logado em 2026-11-05.
export const DEFAULT_URL = "https://www.kimi.ai/";
export const MESSAGE_UNIT_SELECTOR = ".chat-content-item";
export const MESSAGE_ID_ATTR = "data-bridge-id";
export function stampMessages([unitSelector, idAttr]) {
  const seen = {};
  document.querySelectorAll(unitSelector).forEach((el) => {
    const text = el.innerText || "";
    const key = `${text.slice(0, 200)}|${text.length}|${text.slice(-200)}`;
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    seen[hash] = (seen[hash] || 0) + 1;
    el.setAttribute(idAttr, `${(hash >>> 0).toString(36)}.${seen[hash]}:${el.classList.contains("chat-content-item-user") ? "user" : "assistant"}`);
  });
}
export function messageRole(id) { return (id || "").endsWith(":user") ? "user" : "assistant"; }
export function isAssistantMessageId(id) { return (id || "").endsWith(":assistant"); }
export const ASSISTANT_TEXT_SELECTOR = ".markdown-container:not(.toolcall-content-text) > .markdown";
export const STREAMING_SELECTOR = ".send-button-container.stop";
export const CONVERSATION_PATH_RE = /^\/chat\/[a-zA-Z0-9-]+$/;
export const LOGGED_OUT_BUTTON_NAME_RE = /^(log in|sign up|login|entrar)$/i;
export const LOGIN_FIELDS_SELECTOR = 'input[type="email"], input[type="password"], input[type="tel"]';
export const LOGIN_BUTTON_TEXT_RE = /^(log in|login|entrar)$/i;
export const LOGIN_SCREEN_TEXT_RE = /log in|sign in|login|entrar|verification code/i;
export const COMPOSER_SELECTOR = ".chat-input-editor";
export const GENERIC_COMPOSER_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';
export const SEND_BUTTON_NAME_RE = /send|enviar/i;
export const SEND_SELECTOR = ".send-button-container:not(.disabled):not(.stop)";
export const MEDIA_SELECTOR = ".markdown-container:not(.toolcall-content-text) img, .markdown-container:not(.toolcall-content-text) a[download]";
