# Gateway Anthropic → ponte OpenAI

Faz o Claude Code (e qualquer cliente da API da Anthropic) falar com as pontes deste repositório.
Expõe `POST /v1/messages` (com streaming e `tool_use`), `/v1/messages/count_tokens` e `/v1/models`,
e repassa para o `/v1/chat/completions` de uma ponte (padrão: DeepSeek, porta 4337).

Sem dependências. Node 18+.

## Uso

```bash
UPSTREAM_KEY=<chave da ponte> GATEWAY_KEY=<chave que você inventar> node gateway/server.js

# em outro terminal
ANTHROPIC_BASE_URL=http://127.0.0.1:4350 ANTHROPIC_API_KEY=<GATEWAY_KEY> \
  claude --model claude-sonnet-5
```

Qualquer nome de modelo é aceito e vai para `UPSTREAM_MODEL`.

| Variável | Padrão | Função |
|---|---|---|
| `UPSTREAM_URL` | `http://127.0.0.1:4337/v1` | ponte de destino (4327 ChatGPT, 4337 DeepSeek, 4347 Gemini) |
| `UPSTREAM_KEY` | — (obrigatória) | chave da ponte |
| `UPSTREAM_MODEL` | `deepseek-web` | modelo da ponte |
| `GATEWAY_KEY` | vazia | se definida, exige `x-api-key` ou `Authorization: Bearer` |
| `GATEWAY_PORT` / `GATEWAY_HOST` | `4350` / `127.0.0.1` | onde escuta |
| `GATEWAY_BUDGET` | 55000 | máximo de caracteres para prompt de sistema + ferramentas (a ponte limita ~100k no total). Se estourar, o gateway encurta descrições, depois tira as ferramentas `mcp__*`, depois mantém só as básicas |
| `BACKENDS` | só `UPSTREAM_*` | JSON com várias pontes `[{name,url,key,model,maxChars}]`, em ordem |
| `ROUTES` | vazio | JSON `{"haiku":["chatgpt","muse"],"default":["deepseek","muse","chatgpt"]}`: ordem por nome de modelo pedido |
| `GATEWAY_COOLDOWN_MS` | 60000 | pausa de uma ponte que falhou |
| `GATEWAY_CORE_TOOLS` | Read,Write,Edit,Bash,Glob,Grep,… | ferramentas mantidas no último nível |
| `GATEWAY_TIMEOUT_MS` | 450000 | tempo máximo por chamada |

Teste da tradução: `node gateway/test.mjs`. Limites medidos de cada ponte e a regra de roteamento: [`LIMITES.md`](LIMITES.md) (`medir-limite.py` refaz a medição).

## Limites conhecidos (protótipo)

- A resposta da ponte chega inteira; o streaming é simulado (com `ping` a cada 10 s para a conexão não cair).
- O Claude Code manda >100 mil caracteres só de instruções e ferramentas (160 mil com muitos servidores MCP); por isso o gateway encurta descrições e pode tirar as ferramentas MCP. Isso pode piorar o uso de ferramentas mais complexas.
- Uma chamada de ferramenta por turno (limite da ponte). Imagens são omitidas.
- Tokens de uso são estimados; é lento (passa pela interface web) e vale o mesmo risco dos termos de uso das pontes.
- Valide em tarefas reais antes de confiar: só foi testado lendo um arquivo.
