// Mistral Le Chat (chat.mistral.ai). Seletores confirmados no DOM logado em 2026-11-05.
export const DEFAULT_URL = "https://chat.mistral.ai/chat";
export const MESSAGE_UNIT_SELECTOR = "[data-message-author-role]";
export const MESSAGE_ID_ATTR = "data-bridge-id";
export function stampMessages([unitSelector, idAttr]) {
  const seen = {};
  document.querySelectorAll(unitSelector).forEach((el) => {
    const text = el.innerText || "";
    const key = `${text.slice(0, 200)}|${text.length}|${text.slice(-200)}`;
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    seen[hash] = (seen[hash] || 0) + 1;
    el.setAttribute(idAttr, `${(hash >>> 0).toString(36)}.${seen[hash]}:${el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant"}`);
  });
}
export function messageRole(id) { return (id || "").endsWith(":user") ? "user" : "assistant"; }
export function isAssistantMessageId(id) { return (id || "").endsWith(":assistant"); }
export const ASSISTANT_TEXT_SELECTOR = '[data-testid="text-message-part"] .markdown-container-style';
export const STREAMING_SELECTOR = 'button[aria-label="Stop generation"]';
export const CONVERSATION_PATH_RE = /^\/(?:work|chat)\/[a-zA-Z0-9-]+$/;
export const LOGGED_OUT_BUTTON_NAME_RE = /^(log in|sign up|entrar)$/i;
export const LOGIN_FIELDS_SELECTOR = 'input[type="email"], input[type="password"], input[placeholder*="email" i]';
export const LOGIN_BUTTON_TEXT_RE = /^(log in|entrar)$/i;
export const LOGIN_SCREEN_TEXT_RE = /log in|sign in|entrar|verification code/i;
export const COMPOSER_SELECTOR = ".rich-text-editor.ProseMirror";
export const GENERIC_COMPOSER_SELECTOR = 'textarea, [contenteditable="true"]';
export const SEND_BUTTON_NAME_RE = /send|enviar/i;
export const SEND_SELECTOR = 'button[aria-label="Send"]';
export const MEDIA_SELECTOR = '[data-testid="text-message-part"] img, [data-testid="text-message-part"] a[download]';
