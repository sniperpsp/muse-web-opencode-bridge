// Duck.ai (duck.ai, sem login; 1º uso exige clicar "Continue" nos termos). Seletores confirmados no DOM em 2026-11-05.
export const DEFAULT_URL = "https://duck.ai/";
export const MESSAGE_UNIT_SELECTOR = '[data-testid="user-message"], div:has(> h3[data-response-heading])';
export const MESSAGE_ID_ATTR = "data-bridge-id";
export function stampMessages([unitSelector, idAttr]) {
  const seen = {};
  document.querySelectorAll(unitSelector).forEach((el) => {
    const text = el.innerText || "";
    const key = `${text.slice(0, 200)}|${text.length}|${text.slice(-200)}`;
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    seen[hash] = (seen[hash] || 0) + 1;
    el.setAttribute(idAttr, `${(hash >>> 0).toString(36)}.${seen[hash]}:${el.getAttribute("data-testid") === "user-message" ? "user" : "assistant"}`);
  });
}
export function messageRole(id) { return (id || "").endsWith(":user") ? "user" : "assistant"; }
export function isAssistantMessageId(id) { return (id || "").endsWith(":assistant"); }
export const ASSISTANT_TEXT_SELECTOR = ":scope > div:nth-child(3)";
export const STREAMING_SELECTOR = 'button[aria-label="Stop generating"]:not([disabled])';
export const CONVERSATION_PATH_RE = /^\/$/;
export const LOGGED_OUT_BUTTON_NAME_RE = /^(log in|sign up|entrar)$/i;
export const LOGIN_FIELDS_SELECTOR = 'input[type="email"], input[type="password"], input[placeholder*="email" i]';
export const LOGIN_BUTTON_TEXT_RE = /^(log in|entrar)$/i;
export const LOGIN_SCREEN_TEXT_RE = /log in|sign in|entrar|verification code/i;
export const COMPOSER_SELECTOR = 'textarea[name="user-prompt"]';
export const GENERIC_COMPOSER_SELECTOR = 'textarea, [contenteditable="true"]';
export const SEND_BUTTON_NAME_RE = /send|enviar/i;
export const SEND_SELECTOR = 'button[aria-label="Send"]';
export const MEDIA_SELECTOR = ":scope > div:nth-child(3) img";
