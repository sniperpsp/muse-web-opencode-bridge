# Gemini → OpenCode bridge

Derivada da ponte Muse→OpenCode (`sniperpsp/muse-web-opencode-bridge`). Um Chromium dentro do Docker fica logado no Gemini; a ponte expõe uma API compatível com OpenAI e o OpenCode envia as mensagens por ela.

Uso não oficial (automação de navegador). Pode violar os termos da OpenAI e a conta pode ser limitada; use por sua conta e risco.

## Subir

```bash
docker compose up -d --build
```

- Painel: http://127.0.0.1:4347 (a chave e o trecho de config do OpenCode aparecem lá)
- Chromium remoto (para logar): http://127.0.0.1:4348, depois "Confirmar login" no painel
- Provider no OpenCode: baseURL `http://127.0.0.1:4347/v1`, modelo `gemini-web`

## Modelo e site

O modelo é o que o Gemini estiver usando na conversa nova; escolha no Chromium ou use `MUSE_NEW_CHAT_URL=https://gemini.google.com/?model=<slug>`.
Seletores do site ficam em `readChatMessages` (`STREAMING_SELECTOR`, `MUSE_RESPONSE_SELECTOR`) e nas variáveis `MUSE_COMPOSER_SELECTOR`, `MUSE_SEND_SELECTOR`. O resto do comportamento (reenvio, rotação de thread, pendentes, painel) é o da ponte do Gemini; ver sua documentação.
