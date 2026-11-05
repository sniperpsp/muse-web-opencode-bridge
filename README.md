# Pontes web → OpenCode e Claude Code

Pontes que expõem a interface web de um chat de IA como uma API local compatível com OpenAI, e um gateway que as junta atrás de uma única API no formato da Anthropic. Dá para usar no [OpenCode](https://opencode.ai) e no Claude Code. Cada ponte roda em um container Docker com um Chromium próprio: você faz login uma vez, pela tela remota (noVNC), e a sessão fica salva em um volume.

> Projeto comunitário e não oficial. Usa a conta pessoal de cada site, não a API oficial. Mudanças nos sites podem quebrar a automação, e os termos de cada serviço continuam valendo. Cada pessoa autentica a própria conta.

## Peças

| Peça | O que é |
|---|---|
| **Pontes** (`muse/`, `chatgpt/`, `deepseek/`, `gemini/`) | uma por site, cada uma com seu Dockerfile, compose, `src/` e testes |
| **`universal/`** | imagem única para pontes extras: `PROVIDER=<nome>` escolhe o adaptador em `src/sites/` (Qwen, Mistral, Kimi, Z.ai, MiniMax, Duck.ai, DeepSeek) |
| **`gateway/`** | API `POST /v1/messages` (Anthropic) que roteia entre as pontes, liga e desliga os containers, ajusta o prompt ao limite de cada uma e confere as respostas |

## As quatro pontes

| Pasta | Site | API (OpenCode) | Tela de login (noVNC) | Modelo | Maior prompt medido |
|---|---|---|---|---|---|
| [`muse/`](muse) | Muse AI | `http://127.0.0.1:4317/v1` | `http://127.0.0.1:4318` | `muse-web` | 480.000 caracteres |
| [`chatgpt/`](chatgpt) | ChatGPT | `http://127.0.0.1:4327/v1` | `http://127.0.0.1:4328` | `chatgpt-web` | 475.000 caracteres |
| [`deepseek/`](deepseek) | DeepSeek | `http://127.0.0.1:4337/v1` | `http://127.0.0.1:4338` | `deepseek-web` | 475.000 caracteres |
| [`gemini/`](gemini) | Gemini | `http://127.0.0.1:4347/v1` | `http://127.0.0.1:4348` | `gemini-web` | 100.000 caracteres |

O limite padrão no compose é 100.000 caracteres (`MUSE_MAX_PROMPT_CHARS`). Para subir, crie um `.env` na pasta da ponte, por exemplo `MUSE_MAX_PROMPT_CHARS=480000` e `MUSE_ROTATE_CHARS=900000` (no Muse, em `performance.env`). Os valores que funcionam de verdade, ponte por ponte, estão em [`gateway/LIMITES.md`](gateway/LIMITES.md).

Cada chamada espera no máximo 7 minutos (`MUSE_REQUEST_TIMEOUT_MS`). Todas as portas escutam só em `127.0.0.1`. O painel de cada ponte abre na porta da API (ex.: `http://127.0.0.1:4327`).

## Requisitos

- Docker com o plugin Compose (no Windows, dentro do WSL 2; não precisa de Docker Desktop);
- OpenCode e/ou Claude Code instalados.

## Subir uma ponte

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

5. Reinicie o OpenCode e escolha o modelo na lista. O OpenCode só lê a configuração ao abrir: janelas e o servidor `opencode serve` que já estavam rodando precisam ser reiniciados.

## Pontes extras (`universal/`)

Uma imagem, um container por provedor. O adaptador de cada site fica em `universal/src/sites/<provedor>.js` (seletores, regras de login e de resposta).

```bash
cd universal
docker build -t universal-bridge:local .
PROVIDER=qwen PORT_API=4361 PORT_VNC=4362 docker compose -p bridge-qwen up -d
# faça login no noVNC (porta 4362) e pegue a chave: docker exec bridge-qwen cat /data/api-key
```

| Provedor | Portas (API / noVNC) | Maior prompt medido | Observação |
|---|---|---|---|
| `mistral` | 4367 / 4368 | 60.000 | rápido; entra no gateway para conversas pequenas |
| `qwen` | 4361 / 4362 | 70.000 | idem |
| `minimax` | 4373 / 4374 | ~90.000 | é um agente: gasta créditos; captcha trava a página |
| `zai` | 4365 / 4366 | 30.000 | de 100k perde o miolo do texto sem avisar |
| `kimi` | 4363 / 4364 | 30.000 | a cota gratuita esgota em poucas chamadas |
| `duck` | 4369 / 4370 | 10.000 | sem login; o site limita a mensagem a 16.000 caracteres |
| `deepseek` | — | — | adaptador de referência |

O Copilot não funciona: a Microsoft bloqueia o login no Chromium automatizado. Para um site novo, copie um adaptador (por exemplo `qwen.js`) e ajuste os seletores com o site logado. O contrato são os exports que `universal/src/server.js` usa: `DEFAULT_URL`, `MESSAGE_UNIT_SELECTOR`, `ASSISTANT_TEXT_SELECTOR`, `STREAMING_SELECTOR`, `COMPOSER_SELECTOR`, `SEND_SELECTOR`, `CONVERSATION_PATH_RE` e as funções `stampMessages`, `messageRole`, `isAssistantMessageId`. Opcionais: `PAGE_CSS` (esconde elementos por CSS) e `LIMIT_TEXT_RE` (texto de cota/fila do site, vira 429 `provider_quota`).

## Gateway (OpenCode e Claude Code sobre as pontes)

```bash
cp gateway/scripts/gt-* ~/.local/bin/
gt-claude      # Claude Code pelo gateway
gt-opencode    # OpenCode pelo gateway (modelo único "GT Auto")
```

O gateway escolhe a ponte pelo tamanho da conversa, distribui a carga entre réplicas, liga os containers só quando precisam, compacta históricos grandes e reenvia respostas inválidas. Configuração, roteamento e guardrails: [`gateway/README.md`](gateway/README.md). Limites e a rota em uso: [`gateway/LIMITES.md`](gateway/LIMITES.md).

## Dia a dia

- **Atualizar uma ponte:** `cd <pasta> && docker compose up -d --build`. Espere não haver envio em andamento; o login continua no volume.
- **Ver logs:** `docker logs -f chatgpt-opencode-bridge`; do gateway, `~/.config/gateway/gateway.log`.
- **Reenvio de uma chamada:** o OpenCode reenvia o mesmo pedido quando a chamada falha. A ponte reconhece o pedido repetido e volta a ler a resposta que já está na conversa, sem digitar de novo no site.
- **Pedido preso:** o painel tem **Limpar pendentes** e **Reenviar pendentes**. Eles ignoram a sessão que está em andamento. Um pendente antigo (10 min) é liberado quando chega uma mensagem nova.
- **Uma conversa por sessão do OpenCode:** a ponte abre uma conversa nova no site para cada sessão. No ChatGPT, se a conversa ficar grande demais ou quebrar, ela abre uma nova automaticamente.
- **Sessão ocupada (`session_busy`):** só uma chamada por sessão por vez. Espere terminar ou use **Limpar pendentes**.
- **Captcha ou login expirado:** abra a tela remota (noVNC) da ponte e resolva na janela do Chromium.

## Segurança

- A chave da ponte fica no volume (`/data/api-key`) e no seu `opencode.jsonc`; a do gateway, em `~/.config/gateway/key`. Nunca as coloque no repositório nem no chat.
- Os arquivos `.env`, `data/` e `opencode.json*` estão no `.gitignore`.
- Usar a interface web pela automação pode contrariar os termos do serviço. O risco é seu.

## Estrutura

```
muse/       ponte do Muse AI (instalador Windows/WSL, docs, testes)
chatgpt/    ponte do ChatGPT (chatgpt.com)
deepseek/   ponte do DeepSeek (chat.deepseek.com)
gemini/     ponte do Gemini (gemini.google.com)
universal/  imagem única das pontes extras; src/sites/<provedor>.js
gateway/    server.js (sem dependências), test.mjs, LIMITES.md, medir-limite.py
  scripts/  gt-gateway, gt-claude, gt-opencode, replicar.py e exemplos de configuração
```

As pontes são independentes: cada pasta tem `Dockerfile`, `docker-compose.yml`, `src/` e testes (`npm ci && npm test`). O gateway fala `POST /v1/messages` (formato da API da Anthropic, com `tool_use`) e traduz para o `/v1/chat/completions` das pontes.
