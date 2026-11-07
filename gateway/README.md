# Gateway Anthropic → pontes

Faz o Claude Code, o OpenCode e qualquer cliente da API da Anthropic falarem com as pontes deste repositório.
Expõe `POST /v1/messages` (com streaming e `tool_use`), `/v1/messages/count_tokens`, `/v1/models` e `/health`, e traduz para o
`/v1/chat/completions` de uma ou mais pontes. Por cima da tradução ele faz o trabalho que as pontes não fazem:

- **escolhe a ponte** pelo tamanho da conversa e distribui a carga entre réplicas;
- **liga e desliga** os containers sob demanda;
- **cabe o prompt** no limite de cada ponte (enxuga ferramentas, compacta o histórico);
- **confere a resposta** e conserta ou reenvia quando o modelo web devolve algo inválido.

Sem dependências. Node 18+. Estado: usado em sessões reais do OpenCode e do Claude Code; os limites de cada ponte estão em [`LIMITES.md`](LIMITES.md).

## Uso rápido

Os scripts de [`scripts/`](scripts) sobem o gateway com as pontes certas. Copie-os para o PATH e ajuste os caminhos se o repositório não estiver em `/mnt/e/muse-opencode-bridge` (variável `GT_REPO`):

```bash
cp gateway/scripts/gt-* ~/.local/bin/    # garanta que ~/.local/bin está no PATH

gt-claude      # Claude Code pelo gateway (sobe o gateway se preciso)
gt-opencode    # OpenCode pelo gateway, modelo gateway/gt-auto
```

- `gt-gateway` lê as pontes principais do seu `~/.config/opencode/opencode.jsonc` (provedores `deepseek`, `muse`, `chatgpt`, `gemini`) e as extras de `~/.config/gateway/bridges.json` ([exemplo](scripts/bridges.example.json)). Réplicas só entram se o container existir. Na primeira execução ele cria a chave do gateway (`~/.config/gateway/key`) e o `gt-claude` cria o `settings.json`. O log fica em `~/.config/gateway/gateway.log`.
- Para o OpenCode, acrescente o provedor de [`scripts/opencode-provider.example.jsonc`](scripts/opencode-provider.example.jsonc). A chave vem de `~/.config/gateway/key` por `{file:...}`, sem ir para o arquivo.
- Para o Claude Code, `~/.config/gateway/settings.json` usa `apiKeyHelper` (`cat ~/.config/gateway/key`) e `ANTHROPIC_BASE_URL=http://127.0.0.1:4350`.

Sem os scripts, dá para subir direto, com uma ponte só:

```bash
UPSTREAM_KEY=<chave da ponte> GATEWAY_KEY=<chave que você inventar> node gateway/server.js
ANTHROPIC_BASE_URL=http://127.0.0.1:4350 ANTHROPIC_API_KEY=<GATEWAY_KEY> claude
```

## NVIDIA direto no OpenCode

O instalador registra um provedor separado por modelo, todos chamando a API oficial da NVIDIA. Não inicia o gateway local e não troca de modelo se um falhar.

```bash
python3 instalar.py --nvidia
```

Os perfis aparecem no seletor de modelo do OpenCode: Mistral Large 4, Nemotron Bolt/Lightning/Ultra/Super VL, MiniMax e Laguna XS 2.1. A chave é lida de `~/.config/gateway/nvidia.key`; `gt-nvidia-key` configura esse arquivo sem mostrá-la no terminal. A disponibilidade de cada endpoint pode variar por conta/modelo; erro de acesso aparece como erro do próprio modelo, sem fallback silencioso.

## Configuração

| Variável | Padrão | Função |
|---|---|---|
| `UPSTREAM_URL` / `UPSTREAM_KEY` / `UPSTREAM_MODEL` | DeepSeek, `http://127.0.0.1:4337/v1` / — (obrigatória sem `BACKENDS`) / `deepseek-web` | ponte única, quando `BACKENDS` não é usada |
| `BACKENDS` | só `UPSTREAM_*` | JSON com as pontes, veja abaixo |
| `ROUTES` | vazio | ordem de tentativa, veja abaixo |
| `GATEWAY_KEY` | vazia | se definida, exige `x-api-key` ou `Authorization: Bearer` |
| `GATEWAY_PORT` / `GATEWAY_HOST` | `4350` / `127.0.0.1` | onde escuta |
| `GATEWAY_BUDGET` | 55000 (os scripts usam 400000) | máximo de caracteres de sistema + ferramentas. Se estourar: encurta descrições, tira as `mcp__*`, mantém só as básicas |
| `GATEWAY_CORE_TOOLS` | Read, Write, Edit, Bash, Glob, Grep, … | ferramentas mantidas no último nível |
| `GATEWAY_TIMEOUT_MS` | 450000 | tempo máximo por chamada |
| `GATEWAY_COOLDOWN_MS` | 60000 | pausa de uma ponte que falhou (queda de conexão pausa só 5 s) |
| `GATEWAY_IDLE_MS` / `GATEWAY_WARM_MS` | 600000 / 15000 | ocioso para desligar o container / espera para o navegador da ponte abrir |
| `GATEWAY_FIX_RETRIES` | 2 | reenvios com aviso corretivo quando a resposta vem inválida |

Campos de cada item de `BACKENDS`:

| Campo | Função |
|---|---|
| `name`, `url`, `key`, `model` | identificação e acesso (obrigatórios) |
| `maxChars` | maior prompt aceito pela ponte; o gateway compacta o histórico para caber e pula a ponte se mesmo assim não couber |
| `container` | nome do container Docker; liga sob demanda (veja abaixo) |
| `group` | marca a entrada como réplica de outra ponte (valor = nome da original) |
| `concurrency` | pedidos simultâneos nesta ponte (padrão 1; o Muse usa 2 por ter 2 abas) |

## Roteamento

`ROUTES` aceita dois formatos.

**Por demanda (usado hoje, modelo único).** "Demanda" é o tamanho da conversa em caracteres, sem sistema e sem ferramentas. Vence a primeira faixa cujo `max` comporta; a última não tem `max`:

```json
{"tiers":[
  {"max":6000,"chain":["mistral","qwen","deepseek","muse","chatgpt","gemini"]},
  {"chain":["deepseek","muse","chatgpt","gemini"]}
]}
```

Conversa pequena tenta as pontes menores primeiro; maior vai para o DeepSeek. O nome do modelo pedido é ignorado, então o OpenCode e o Claude Code usam um modelo só ("GT Auto"). Dentro de uma sessão a conversa só cresce: ela sobe de faixa e nunca volta para uma ponte menor. Se uma ponte falha (cota, captcha, erro, resposta inválida), cai para a próxima; a cadeia sempre termina nas pontes grandes.

**Por nome de modelo.** `{"haiku":["chatgpt","muse"],"default":["deepseek","muse","chatgpt"]}`: a chave é um trecho do nome pedido (o Claude Code usa `haiku` nos subagentes). Vence a primeira que casar.

### Réplicas e distribuição de carga

Cada ponte atende um pedido por vez (uma aba). Para atender vários, o gateway usa **réplicas**: cópias do container com o volume clonado (logadas igual), declaradas com `"group": "<ponte>"`. Na cadeia, um nome vale para a ponte e todas as réplicas.

- Cada demanda vai para **uma** ponte: a menos ocupada do grupo, preferindo a que já está ligada.
- Se todas do grupo estão cheias, passa para o próximo grupo da cadeia; se não há outro, espera na fila da menos ocupada.
- Pontes em pausa por falha recente vão para o fim da fila, não são descartadas.
- Réplicas em uso: DeepSeek ×3 (leve, ~360 MB cada), ChatGPT ×2 (pesado, 1,3–1,8 GB), Gemini ×1, Muse 1 container com 2 abas (`MUSE_MAX_TABS=2` em `muse/performance.env`).

Crie réplicas com [`scripts/replicar.py`](scripts/replicar.py) (`python3 gateway/scripts/replicar.py deepseek 4437 4438 2`). Ela clona o volume com a original parada por alguns segundos.

### Ligar sob demanda

Com `container` na entrada, o gateway liga o container (`docker start`) quando um pedido o escolhe, espera a ponte responder (`GATEWAY_WARM_MS`) e repete o pedido enquanto ela responde 503 "reconectando". Sem uso por `GATEWAY_IDLE_MS`, desliga. **Só desliga o que ele mesmo ligou**: container que já estava de pé (por exemplo, usado direto pelo OpenCode) nunca é parado. Precisa de `docker` no PATH de quem roda o gateway.

## Guardrails

### Prompt grande demais

1. **Sistema e ferramentas** passam por níveis até caber em `GATEWAY_BUDGET`: descrições mais curtas, depois sem as ferramentas MCP, depois só as básicas.
2. **Histórico:** se a conversa ainda não cabe em `maxChars`, `compactMessages` corta resultados de ferramenta e textos longos das mensagens antigas (a primeira, que é a tarefa, e as 8 últimas ficam intactas). Se ainda não couber, descarta as mais antigas, remove `tool_result` órfão e deixa um aviso de que houve omissão. O log mostra `histórico compactado para <ponte>: antes -> depois`.

Teste: um histórico de 709k caracteres virou 152k e o modelo ainda respondeu o código da primeira mensagem. No OpenCode, `limit.context` do GT Auto é 80000 tokens, para ele resumir a sessão antes de chegar ao teto.

### Resposta inválida

Toda resposta passa por `checkResponse` antes de ir ao cliente.

- **Conserta sozinho:** lixo de bloco de código no início (`json` + numeração de linhas), chamada de ferramenta escrita como texto (`{"type":"grep",...}` ou `{"name":"shell","arguments":{...}}`), apelido de ferramenta (`shell` → `bash`, `cat` → `read`, …), `cmd`/`script` no lugar de `command` e o campo `description` obrigatório que faltou. **Só converte se o destino for uma ferramenta que o cliente declarou.**
- **Detecta:** resposta vazia, ferramenta inexistente, argumentos que não são JSON, campos obrigatórios faltando (pelo `input_schema` do cliente) e JSON de ferramenta cortado.
- **Reenvia:** com problema, manda de novo (conversa nova na ponte) com um aviso que lista os nomes de ferramenta válidos, até `GATEWAY_FIX_RETRIES` vezes. Se persistir, passa para a próxima ponte sem pausar a atual (o defeito é do modelo, não da ponte). Se todas falharem, devolve um erro claro e o cliente tenta de novo.

O log registra cada caso: `chamada de ferramenta recuperada do texto: <ferramenta>`, `resposta inválida de <ponte> (<motivo>); reenviando n/2`.

Sem isso, o cliente trata o texto vazado como resposta final e o turno termina sem o trabalho feito.

## Limites conhecidos

- A resposta da ponte chega inteira; o streaming é simulado (com `ping` a cada 10 s para a conexão não cair).
- Uma chamada de ferramenta por turno (limite das pontes). Imagens são omitidas.
- Tokens de uso são estimados. É lento (passa pela interface web) e vale o risco dos termos de uso dos sites.
- O gateway não julga se uma resposta bem formatada está certa (por exemplo, um comando inadequado).
- Cada reenvio corretivo custa outra chamada (7–50 s).
- A compactação perde detalhe das mensagens antigas; em sessão muito longa o modelo pode esquecer o que leu no começo.

## Testes

```bash
node gateway/test.mjs   # tradução, roteamento, réplicas, compactação, recuperação de ferramenta e validação
```

`medir-limite.py` refaz a medição de cada ponte (ver [`LIMITES.md`](LIMITES.md)).
