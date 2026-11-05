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

## Ligar sob demanda

Se um backend tiver `"container": "<nome do container docker>"` em `BACKENDS`, o gateway liga o container (`docker start`) quando um pedido o escolhe,
espera a ponte responder (`GATEWAY_WARM_MS`, padrão 15000, para o navegador abrir) e repete na mesma ponte enquanto ela responde 503 "reconectando".
Depois de `GATEWAY_IDLE_MS` (padrão 600000 = 10 min) sem uso, desliga. **Só desliga o que ele mesmo ligou**: um container que já estava de pé
(por exemplo usado direto pelo OpenCode) nunca é parado. Requer `docker` no PATH de quem roda o gateway.

## Roteamento por demanda (modelo único)

`ROUTES` também aceita faixas: `{"tiers":[{"max":6000,"chain":["mistral","qwen","deepseek","muse"]},{"chain":["deepseek","muse","chatgpt","gemini"]}]}`.
A demanda é o tamanho da conversa em chars (sem sistema/ferramentas). Conversa pequena tenta as pontes menores primeiro; maior vai para o DeepSeek.
O nome do modelo pedido é ignorado, então o OpenCode e o Claude Code usam um único modelo ("GT Auto"). Se uma ponte falhar (cota, captcha, erro),
cai para a próxima da cadeia, que sempre termina nas pontes grandes. Dentro de uma sessão a conversa só cresce: ela sobe de faixa e não volta.
Os scripts do usuário (`gt-gateway`, `gt-claude`, `gt-opencode`) ficam em `~/.local/bin`; as pontes pequenas ficam em `~/.config/gateway/bridges.json`.

## Réplicas e distribuição de carga

Um backend pode ter réplicas: entradas com `"group": "<nome do backend original>"` (cópias do container com o volume clonado, logadas igual; ex.: `deepseek-opencode-bridge-2`, portas 4437/4537).
Na cadeia, o nome do grupo vale para a ponte e todas as réplicas. Cada demanda vai para **uma** ponte: a menos ocupada do grupo (`inflight`), preferindo a que já está ligada;
`concurrency` (padrão 1) limita pedidos simultâneos por ponte (o Muse tem 2 abas, então 2). Se todas do grupo estão cheias, passa para o próximo grupo da cadeia.
Pontes em pausa por falha recente vão para o fim da fila (não são descartadas), e queda de conexão (reinício) pausa só 5 s. Se nada comporta o prompt, o erro devolvido é o da última ponte tentada, não o de tamanho.
Réplicas atuais: DeepSeek ×3 (leve, ~360 MB cada), ChatGPT ×2 (pesado, 1,3–1,8 GB), Gemini ×1, Muse 1 container com 2 abas.

## Chamada de ferramenta escrita como texto

Se a ponte devolve como texto algo como `{"type":"grep","pattern":"x"}` ou `{"name":"grep","arguments":{...}}`, o gateway converte em `tool_use`
**somente se o nome (ou um apelido conhecido, como `shell` → `bash`) for de uma ferramenta que o cliente declarou**; ignora lixo antes do JSON (cabeçalho "json" e numeração de linhas do bloco de código) (`salvageToolCall`); nos demais casos segue como texto. Cada recuperação aparece no log
("chamada de ferramenta recuperada do texto"). Sem isso o cliente trata como resposta final e o turno termina sem o trabalho feito.

## Histórico grande (compactação)

Se a conversa não cabe em `maxChars` da ponte, o gateway compacta o histórico (`compactMessages`) antes de recusar: 1) corta resultados de ferramenta e textos
longos das mensagens antigas (as últimas 8 e a primeira, que é a tarefa, ficam intactas); 2) se ainda não couber, descarta as mensagens mais antigas e
remove `tool_result` órfão, inserindo um aviso de que mensagens foram omitidas. O log mostra "histórico compactado para <ponte>: antes -> depois".
Teste: histórico de 709k chars virou 152k e o modelo ainda respondeu o código da 1ª mensagem. No OpenCode, `limit.context` do GT Auto é 80000 (tokens), para ele também compactar antes.

## Guardrails (validação da resposta)

Toda resposta da ponte passa por `checkResponse` antes de ir ao cliente:
- **Conserta sozinho:** lixo de bloco de código no início do texto (`json` + numeração de linhas), chamada de ferramenta escrita como texto, apelido de ferramenta (`shell` → `bash`), `cmd`/`script` no lugar de `command`, e `description` obrigatório que faltou (derivado do comando).
- **Detecta problema:** resposta vazia, ferramenta inexistente, argumentos que não são JSON, campos obrigatórios faltando (pelo `input_schema` do cliente) e JSON de ferramenta truncado/quebrado.
- **Reenvia:** com problema, manda de novo (conversa nova na ponte) com um aviso corretivo que lista os nomes de ferramenta válidos, até `GATEWAY_FIX_RETRIES` vezes (padrão 2). Se persistir, passa para a próxima ponte **sem** colocar a atual em pausa (o defeito é do modelo, não da ponte). Se todas falharem, devolve erro claro ao cliente, que tenta de novo.
O log registra cada caso: "resposta inválida de <ponte> (<motivo>); reenviando n/2".
