# Pontes web → OpenCode

Quatro pontes que expõem a interface web de um chat de IA como uma API local compatível com OpenAI, para usar no [OpenCode](https://opencode.ai). Cada ponte roda em um container Docker com um Chromium próprio: você faz login uma vez, pela tela remota (noVNC), e a sessão fica salva em um volume.

> Projeto comunitário e não oficial. Usa a conta pessoal de cada site, não a API oficial. Mudanças nos sites podem quebrar a automação, e os termos de cada serviço continuam valendo. Cada pessoa autentica a própria conta.

| Pasta | Site | API (OpenCode) | Tela de login (noVNC) | Modelo | Limite de prompt |
|---|---|---|---|---|---|
| [`muse/`](muse) | Muse AI | `http://127.0.0.1:4317/v1` | `http://127.0.0.1:4318` | `muse-web` | 500.000 caracteres |
| [`chatgpt/`](chatgpt) | ChatGPT | `http://127.0.0.1:4327/v1` | `http://127.0.0.1:4328` | `chatgpt-web` | 100.000 caracteres |
| [`deepseek/`](deepseek) | DeepSeek | `http://127.0.0.1:4337/v1` | `http://127.0.0.1:4338` | `deepseek-web` | 100.000 caracteres |
| [`gemini/`](gemini) | Gemini | `http://127.0.0.1:4347/v1` | `http://127.0.0.1:4348` | `gemini-web` | 100.000 caracteres |

Cada chamada espera no máximo 7 minutos. Todas as portas escutam só em `127.0.0.1`. O painel de cada ponte abre na porta da API (ex.: `http://127.0.0.1:4327`).

## Requisitos

- Docker com o plugin Compose (no Windows, dentro do WSL 2; não precisa de Docker Desktop);
- OpenCode instalado.

## Como usar

### Muse (com instalador)

O Muse tem instalador que sobe o container e registra o provedor no OpenCode. Veja [`muse/README.md`](muse/README.md).

```bash
cd muse
bash instalar.sh
```

### ChatGPT, DeepSeek e Gemini

1. Suba a ponte (troque `chatgpt` por `deepseek` ou `gemini`):

   ```bash
   cd chatgpt
   docker compose up -d --build
   ```

   O volume com o login e a chave da API é criado na primeira subida (`chatgpt-opencode-bridge-data`) e sobrevive a rebuilds.

2. Faça login uma vez: abra o painel (`http://127.0.0.1:4327`), clique em **Abrir Chromium** e entre na conta pela tela remota (noVNC). Depois clique em **Confirmar login**.

3. Pegue a chave da ponte (não a divulgue):

   ```bash
   docker exec chatgpt-opencode-bridge cat /data/api-key
   ```

4. Registre no `~/.config/opencode/opencode.jsonc`, dentro de `"provider"`:

   ```jsonc
   "chatgpt": {
     "npm": "@ai-sdk/openai-compatible",
     "name": "ChatGPT (navegador local)",
     "options": {
       "baseURL": "http://127.0.0.1:4327/v1",
       "apiKey": "COLE_A_CHAVE_AQUI",
       "timeout": 600000,
       "headerTimeout": 600000
     },
     "models": {
       "chatgpt-web": {
         "name": "ChatGPT Web",
         "limit": { "context": 128000, "input": 100000, "output": 16000 }
       }
     }
   }
   ```

   Para DeepSeek e Gemini, troque nome, porta e modelo pela tabela acima.

5. Reinicie o OpenCode e escolha o modelo na lista.

## Dia a dia

- **Atualizar uma ponte:** `cd <pasta> && docker compose up -d --build`. Espere não haver envio em andamento; o login continua no volume.
- **Ver logs:** `docker logs -f chatgpt-opencode-bridge`.
- **Reenvio de uma chamada:** o OpenCode reenvia o mesmo pedido quando a chamada falha. A ponte reconhece o pedido repetido e volta a ler a resposta que já está na conversa, sem digitar de novo no site.
- **Pedido preso:** o painel tem **Limpar pendentes** e **Reenviar pendentes**. Eles ignoram a sessão que está em andamento. Um pendente antigo (10 min) é liberado quando chega uma mensagem nova.
- **Uma conversa por sessão do OpenCode:** a ponte abre uma conversa nova no site para cada sessão. No ChatGPT, se a conversa ficar grande demais ou quebrar, ela abre uma nova automaticamente.
- **Sessão ocupada (`session_busy`):** só uma chamada por sessão por vez. Espere terminar ou use **Limpar pendentes**.
- **Captcha ou login expirado:** abra a tela remota (noVNC) da ponte e resolva na janela do Chromium.

## Segurança

- A chave da ponte fica no volume (`/data/api-key`) e no seu `opencode.jsonc`. Nunca a coloque no repositório nem no chat.
- Os arquivos `.env`, `data/` e `opencode.json*` estão no `.gitignore`.
- Usar a interface web pela automação pode contrariar os termos do serviço. O risco é seu.

## Estrutura

```
muse/       ponte do Muse AI (instalador Windows/WSL, docs, testes)
chatgpt/    ponte do ChatGPT (chatgpt.com)
deepseek/   ponte do DeepSeek (chat.deepseek.com)
gemini/     ponte do Gemini (gemini.google.com)
gateway/    gateway Anthropic: deixa o Claude Code falar com qualquer ponte acima
```

- **As 4 pontes** (`muse`, `chatgpt`, `deepseek`, `gemini`): cada uma sobe um Chromium em Docker, mantém o seu login no site e expõe uma API compatível com OpenAI (`/v1/chat/completions`). São independentes: cada pasta tem `Dockerfile`, `docker-compose.yml`, `src/` e testes (`npm ci && npm test`).
- **`gateway/`**: serviço pequeno, sem dependências, que expõe `POST /v1/messages` (formato da API da Anthropic, com `tool_use`) e traduz para o `/v1/chat/completions` de uma ponte (padrão: DeepSeek). Com ele, `ANTHROPIC_BASE_URL=http://127.0.0.1:4350 claude` usa o chat do DeepSeek por trás. É um protótipo: veja os limites e as variáveis em [`gateway/README.md`](gateway/README.md).

## Gateway (Claude Code sobre as pontes)

```bash
UPSTREAM_KEY=<chave da ponte> GATEWAY_KEY=<chave que você inventar> node gateway/server.js
ANTHROPIC_BASE_URL=http://127.0.0.1:4350 ANTHROPIC_API_KEY=<GATEWAY_KEY> claude
```

Qualquer nome de modelo é aceito e vai para o modelo da ponte. Testado com chat, chamada de ferramenta, streaming e o Claude Code lendo um arquivo.
