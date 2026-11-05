// Valores ainda do ChatGPT: ajustar para o Gemini depois do login (fase seguinte)
// Tudo que depende do HTML ou dos textos do site fica aqui. As variáveis MUSE_*_SELECTOR do ambiente continuam tendo prioridade no server.js.
// Funções exportadas que rodam dentro da página são serializadas com toString(): não podem usar nada fora do próprio corpo.

// O Gemini não põe id nas mensagens: são <user-query> e <model-response>. stampMessages grava
// data-bridge-id="m<n>:user|assistant" (pelo tipo do elemento) para a ponte usar o mesmo esquema do ChatGPT.
export const MESSAGE_UNIT_SELECTOR = "user-query, model-response";
export const MESSAGE_ID_ATTRIBUTE = "data-bridge-id";
export function stampMessages([unitSelector, idAttr]) {
  document.querySelectorAll(unitSelector).forEach((el, i) => el.setAttribute(idAttr, `m${i}:${el.tagName === "USER-QUERY" ? "user" : "assistant"}`));
}
export function messageRole(id) {
  return (id || "").endsWith(":user") ? "user" : "assistant";
}

// Texto da resposta do assistente dentro da mensagem.
export const ASSISTANT_TEXT_SELECTOR = '.model-response-text';
// Botão de parar: enquanto existir, a resposta ainda está sendo gerada.
export const STREAMING_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Parar" i], [data-testid="stop-button"]';

// Caminho de uma conversa salva (ex.: /app/c1d53696a238146c).
export const CONVERSATION_PATH = /^\/app\/[a-zA-Z0-9]+$/;

// Botão que só aparece deslogado.
export const LOGGED_OUT_BUTTON_NAME = /^(log in|sign up for free|entrar|fazer login)$/i;
// Textos de tela de login; usados dentro da página, então o server.js passa source/flags.
export const LOGIN_BUTTON_TEXT = /^(log in|entrar)$/i;
export const LOGIN_SCREEN_TEXT = /log in|sign in|log into|entrar|iniciar sess[aã]o|c[oó]digo de (?:login|verifica)|verification code|login code/i;
export const LOGIN_FIELD_SELECTOR = 'input[type="email"], input[type="password"], input[autocomplete="username"], input[autocomplete="one-time-code"], input[placeholder*="email" i], input[placeholder*="e-mail" i]';

// Caixa de mensagem: seletores com rótulo (preferidos) e genérico.
export const COMPOSER_SELECTORS = [
  'div.ql-editor[role="textbox"]',
  'textarea[placeholder*="mensagem" i]', 'textarea[placeholder*="message" i]',
  'textarea[aria-label*="mensagem" i]', 'textarea[aria-label*="message" i]',
  '[contenteditable="true"][aria-label*="mensagem" i]', '[contenteditable="true"][aria-label*="message" i]',
  'input[placeholder*="mensagem" i]', 'input[placeholder*="message" i]',
];
export const LABELED_COMPOSER_SELECTOR = COMPOSER_SELECTORS.join(", ");
export const GENERIC_COMPOSER_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

// Botão de enviar pelo nome acessível.
export const SEND_BUTTON_NAME = /enviar|send|mandar|submit/i;

// Mídia da resposta (imagem/áudio/vídeo/download): só dentro das respostas; 'main' inteiro pegava imagens da página e encerrava a espera com texto vazio.
export const MEDIA_SELECTOR = 'model-response img, model-response audio, model-response video, model-response a[download]';
