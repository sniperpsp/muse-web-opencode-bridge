// Valores ainda do ChatGPT: ajustar para o DeepSeek depois do login (fase seguinte)
//
// Tudo que é específico do site da IA fica aqui: seletores da página, papel das mensagens
// e regexes de estado (logado / tela de login / conversa). Os valores são os do ChatGPT,
// que é o que hoje funciona. Ainda não há seletores do DeepSeek.
// Os seletores MUSE_*_SELECTOR por variável de ambiente continuam tendo prioridade (ver server.js).

// Unidade de mensagem: o DeepSeek não põe id nas mensagens e a lista é virtualizada (mensagens antigas saem do DOM),
// então índice/paridade não servem. stampMessages grava data-bridge-id="<hash do texto>.<n>:user|assistant"; o papel vem
// de .ds-markdown (só as respostas do assistente têm). Um hash estável mantém o id da mensagem mesmo se o início da lista sumir.
export const DEFAULT_URL = "https://chat.deepseek.com/";
export const MESSAGE_UNIT_SELECTOR = ".ds-message";
export const MESSAGE_ID_ATTR = "data-bridge-id";
export function stampMessages([unitSelector, idAttr]) {
  const seen = {};
  document.querySelectorAll(unitSelector).forEach((el) => {
    const text = el.innerText || "";
    const key = `${text.slice(0, 200)}|${text.length}|${text.slice(-200)}`;
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    seen[hash] = (seen[hash] || 0) + 1;
    el.setAttribute(idAttr, `${(hash >>> 0).toString(36)}.${seen[hash]}:${el.querySelector(".ds-markdown") ? "assistant" : "user"}`);
  });
}

// Papel decidido pelo id. Funções sem closure: são serializadas e reavaliadas dentro da página (ver readChatMessages).
export function messageRole(id) {
  return (id || "").endsWith(":user") ? "user" : "assistant";
}
export function isAssistantMessageId(id) {
  return (id || "").endsWith(":assistant");
}

// Texto da resposta do assistente dentro da unidade de mensagem.
export const ASSISTANT_TEXT_SELECTOR = '.ds-markdown';

// Botão de parar: enquanto existe e está visível, a resposta ainda está sendo escrita.
export const STREAMING_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Parar" i], [data-testid="stop-button"]';

// URL de conversa, ex.: /a/chat/s/<uuid>
export const CONVERSATION_PATH_RE = /^\/a\/chat\/s\/[a-zA-Z0-9-]+$/;

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

// Botão de enviar do DeepSeek: div role=button circular primário (sem nome acessível). Vazio = detecção genérica.
export const SEND_SELECTOR = 'div.ds-button--primary.ds-button--circle[role="button"]';

// Mídia da resposta (imagem/áudio/vídeo/download): só dentro das respostas; 'main' inteiro pegava imagens da página e encerrava a espera com texto vazio.
export const MEDIA_SELECTOR = '.ds-markdown img, .ds-markdown audio, .ds-markdown video, .ds-markdown a[download]';
