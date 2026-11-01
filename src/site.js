// Valores ainda do ChatGPT: ajustar para o Gemini depois do login (fase seguinte)
// Tudo que depende do HTML ou dos textos do site fica aqui. As variáveis MUSE_*_SELECTOR do ambiente continuam tendo prioridade no server.js.
// Funções exportadas que rodam dentro da página são serializadas com toString(): não podem usar nada fora do próprio corpo.

// Cada mensagem é um elemento com este atributo; o valor termina em ":user" ou ":assistant".
export const MESSAGE_UNIT_SELECTOR = "[data-content-search-unit-key]";
export const MESSAGE_ID_ATTRIBUTE = "data-content-search-unit-key";
export function messageRole(id) {
  return id.endsWith(":user") ? "user" : "assistant";
}

// Texto da resposta do assistente dentro da mensagem.
export const ASSISTANT_TEXT_SELECTOR = '[data-markdown-text-style="assistant-message"]';
// Botão de parar: enquanto existir, a resposta ainda está sendo gerada.
export const STREAMING_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Parar" i], [data-testid="stop-button"]';

// Caminho de uma conversa salva (ex.: /c/abc-123).
export const CONVERSATION_PATH = /^\/c\/[a-zA-Z0-9-]+$/;

// Botão que só aparece deslogado.
export const LOGGED_OUT_BUTTON_NAME = /^(log in|sign up for free|entrar|fazer login)$/i;
// Textos de tela de login; usados dentro da página, então o server.js passa source/flags.
export const LOGIN_BUTTON_TEXT = /^(log in|entrar)$/i;
export const LOGIN_SCREEN_TEXT = /log in|sign in|log into|entrar|iniciar sess[aã]o|c[oó]digo de (?:login|verifica)|verification code|login code/i;
export const LOGIN_FIELD_SELECTOR = 'input[type="email"], input[type="password"], input[autocomplete="username"], input[autocomplete="one-time-code"], input[placeholder*="email" i], input[placeholder*="e-mail" i]';

// Caixa de mensagem: seletores com rótulo (preferidos) e genérico.
export const COMPOSER_SELECTORS = [
  'textarea[placeholder*="mensagem" i]', 'textarea[placeholder*="message" i]',
  'textarea[aria-label*="mensagem" i]', 'textarea[aria-label*="message" i]',
  '[contenteditable="true"][aria-label*="mensagem" i]', '[contenteditable="true"][aria-label*="message" i]',
  'input[placeholder*="mensagem" i]', 'input[placeholder*="message" i]',
];
export const LABELED_COMPOSER_SELECTOR = COMPOSER_SELECTORS.join(", ");
export const GENERIC_COMPOSER_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

// Botão de enviar pelo nome acessível.
export const SEND_BUTTON_NAME = /enviar|send|mandar|submit/i;
