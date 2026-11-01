// Valores ainda do ChatGPT: ajustar para o DeepSeek depois do login (fase seguinte)
//
// Tudo que é específico do site da IA fica aqui: seletores da página, papel das mensagens
// e regexes de estado (logado / tela de login / conversa). Os valores são os do ChatGPT,
// que é o que hoje funciona. Ainda não há seletores do DeepSeek.
// Os seletores MUSE_*_SELECTOR por variável de ambiente continuam tendo prioridade (ver server.js).

// Unidade de mensagem: cada mensagem é um elemento com este atributo; o id termina em ":user" ou ":assistant".
export const MESSAGE_UNIT_SELECTOR = "[data-content-search-unit-key]";
export const MESSAGE_ID_ATTR = "data-content-search-unit-key";

// Papel decidido pelo id. Funções sem closure: são serializadas e reavaliadas dentro da página (ver readChatMessages).
export function messageRole(id) {
  return id.endsWith(":user") ? "user" : "assistant";
}
export function isAssistantMessageId(id) {
  return id.endsWith(":assistant");
}

// Texto da resposta do assistente dentro da unidade de mensagem.
export const ASSISTANT_TEXT_SELECTOR = '[data-markdown-text-style="assistant-message"]';

// Botão de parar: enquanto existe e está visível, a resposta ainda está sendo escrita.
export const STREAMING_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Parar" i], [data-testid="stop-button"]';

// URL de conversa, ex.: /c/<id>
export const CONVERSATION_PATH_RE = /^\/c\/[a-zA-Z0-9-]+$/;

// Deslogado: o botão de entrar / cadastrar aparece na página.
export const LOGGED_OUT_BUTTON_NAME_RE = /^(log in|sign up for free|entrar|fazer login)$/i;
// Tela de autenticação: campos de login e textos típicos. Usados dentro de page.evaluate (ver server.js).
export const LOGIN_FIELDS_SELECTOR = 'input[type="email"], input[type="password"], input[autocomplete="username"], input[autocomplete="one-time-code"], input[placeholder*="email" i], input[placeholder*="e-mail" i]';
export const LOGIN_BUTTON_TEXT_RE = /^(log in|entrar)$/i;
export const LOGIN_SCREEN_TEXT_RE = /log in|sign in|log into|entrar|iniciar sess[aã]o|c[oó]digo de (?:login|verifica)|verification code|login code/i;

// Caixa de mensagem (composer): seletores em ordem de preferência; o último visível vence.
export const COMPOSER_SELECTOR = [
  'textarea[placeholder*="mensagem" i]', 'textarea[placeholder*="message" i]',
  'textarea[aria-label*="mensagem" i]', 'textarea[aria-label*="message" i]',
  '[contenteditable="true"][aria-label*="mensagem" i]', '[contenteditable="true"][aria-label*="message" i]',
  'input[placeholder*="mensagem" i]', 'input[placeholder*="message" i]',
].join(", ");
export const GENERIC_COMPOSER_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

// Botão de enviar, quando não há MUSE_SEND_SELECTOR.
export const SEND_BUTTON_NAME_RE = /enviar|send|mandar|submit/i;
