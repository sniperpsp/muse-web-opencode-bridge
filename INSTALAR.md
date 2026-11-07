# Instalação guiada por agente

Este arquivo é para **um agente de IA** (Claude Code, OpenCode, Codex, Gemini CLI…) instalar o projeto para a pessoa que o pediu.
A pessoa só precisa dizer algo como *"instale este projeto seguindo o INSTALAR.md"*, escolher quais sites quer e fazer o login nas janelas que o agente abrir.

## Regras para o agente

- **Pergunte antes de instalar:** quais sites (veja a tabela), se quer o gateway (`gt-claude` / `gt-opencode`) e se quer os **modelos GT NVIDIA** (seção 2b). Sem resposta, instale só o DeepSeek, que é o mais leve e rápido.
- **Nunca peça nem digite senha da pessoa.** O login é feito por ela, na janela do navegador que o instalador abre. Você só avisa e espera.
- **Não mostre chaves** (`/data/api-key`, `~/.config/gateway/key`, `~/.config/gateway/nvidia.key`) no chat nem em commits.
- **Nunca peça a chave da NVIDIA no chat.** Quem digita é a pessoa, no terminal dela, com `gt-nvidia-key` (a chave não aparece na tela e é validada antes de salvar). Você só pede que ela rode o comando e avise quando terminar.
- **Não apague nem sobrescreva** o `opencode.jsonc` da pessoa. O instalador só acrescenta provedores e faz backup (`.bak-pontes-<data>`).
- Usar a interface web de um chat por automação pode contrariar os termos do site. Avise isso uma vez.
- Se algo falhar, mostre o erro real e a causa provável. Não repita o mesmo comando às cegas.

## 1. Confirme o ambiente

```bash
docker info >/dev/null && docker compose version && node --version   # Node só para o gateway (18+)
free -m | sed -n 2p                                                    # memória livre
```

- No Windows, tudo roda **dentro do WSL 2**. Se o Docker não responde, a pessoa precisa instalar/iniciar o Docker no WSL.
- Memória aproximada por container: DeepSeek ~0,4 GB, Muse ~0,8 GB, Gemini ~1 GB, ChatGPT 1,3 a 1,8 GB. Com menos de ~3 GB livres, sugira só DeepSeek e Muse.

## 2. Escolha as pontes

| Nome para `--pontes` | Site | Observação |
|---|---|---|
| `deepseek` | DeepSeek | mais leve e rápido; prompt de até ~475k caracteres |
| `muse` | Muse AI | 2 abas; até ~480k |
| `chatgpt` | ChatGPT | pesado e lento (36–48 s por chamada); até ~475k |
| `gemini` | Gemini | até ~100k; lento |

## 2b. Modelos GT NVIDIA (opcional, sem ponte)

Dez modelos da API oficial da NVIDIA aparecem no seletor do OpenCode ao lado do GT Auto, como **GT NVIDIA <modelo>**. Não sobem container nem precisam de login em site: só de uma chave grátis de https://build.nvidia.com (botão *Get API Key*, começa com `nvapi-`). A parte cinza do seletor diz para que cada um é bom:

| No seletor | Para que é bom | Lê imagem |
|---|---|---|
{table}

Como sugerir à pessoa: **GT NVIDIA Ultra 550B** para conversa, texto e código; **GT NVIDIA Super VL** quando ela anexar imagem ou print; **GT NVIDIA Bolt** para tarefas rápidas e simples.

1. Peça para a pessoa rodar no terminal dela: `gt-nvidia-key` (se o comando ainda não existir: `bash gateway/scripts/gt-nvidia-key` na pasta do projeto). Espere ela confirmar "chave válida e salva".
2. Rode (pode ser em segundo plano, não pergunta nada se a chave já estiver salva):

```bash
python3 instalar.py --nvidia                                                      # OpenCode do WSL/Linux
python3 instalar.py --nvidia --config /mnt/c/Users/<pessoa>/.config/opencode/opencode.jsonc   # OpenCode do Windows
```

   No Windows, o instalador copia a chave para `C:\Users\<pessoa>\.config\gateway\` sozinho.
3. Junto com as pontes: `python3 instalar.py --pontes deepseek --com-nvidia` (ou `--sem-nvidia` para não perguntar).
4. A linha `RESULTADO` traz `"nvidia": true` quando os perfis foram registrados. Se vier `false` com o aviso "sem chave NVIDIA salva", volte ao passo 1.

## 3. Rode o instalador

O instalador sobe os containers, abre a janela de login de cada site no navegador da pessoa, espera o login ser detectado, lê as chaves, testa com um "pong" e registra tudo no `~/.config/opencode/opencode.jsonc`. A espera pelo login pode levar vários minutos, então **rode em segundo plano** e acompanhe a saída:

```bash
python3 instalar.py --pontes deepseek,muse            # sem --sem-gateway: instala também gt-claude e gt-opencode
# opções: --todas | --sem-gateway | --sem-abrir | --sem-teste | --com-nvidia | --sem-nvidia | --config <arquivo do opencode>
```

Enquanto ele espera:

1. Diga à pessoa: *"abri uma janela para cada site; entre na sua conta (e resolva captcha ou verificação, se pedir). Me avise se alguma janela não abriu."*
2. Se a janela não abriu (sem navegador padrão, WSL sem `wslview`), o instalador imprime o endereço `http://127.0.0.1:<porta>/vnc.html?...`: entregue o link à pessoa. As portas da tela remota são 4338 (DeepSeek), 4318 (Muse), 4328 (ChatGPT) e 4348 (Gemini).
3. Acompanhe a saída até a linha `RESULTADO {...}`:
   - `prontas`: pontes logadas, testadas e registradas;
   - `sem_login`: pontes puladas (a pessoa não logou a tempo). Rode `python3 instalar.py --pontes <essas>` de novo quando ela quiser;
   - `gateway`: `true` se instalou os comandos;
   - `nvidia`: `true` se os perfis GT NVIDIA foram registrados.

O instalador pode ser repetido: o que já está de pé, logado ou registrado é pulado.

## 4. Confira e entregue

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep opencode-bridge
gt-gateway && curl -s http://127.0.0.1:4350/health     # só se instalou o gateway; deve responder {"ok":true}
```

Diga à pessoa:

- **OpenCode:** fechar e abrir de novo (ele só lê a configuração ao abrir) e escolher o modelo na lista. Com gateway: `gt-opencode` (modelo único "GT Auto"). Com NVIDIA: digitar **GT NVIDIA** no seletor. Se ela usa `opencode serve` (systemd), esse servidor também precisa reiniciar.
- **Claude Code pelo gateway:** `gt-claude`.
- Se `gt-claude` / `gt-opencode` não forem encontrados, `~/.local/bin` não está no PATH: `export PATH="$HOME/.local/bin:$PATH"` no `~/.bashrc`.
- Onde ver problemas: `docker logs -f <ponte>-opencode-bridge` e `~/.config/gateway/gateway.log`.

## Problemas comuns

| Sintoma | Causa provável e o que fazer |
|---|---|
| `Falhou subir a ponte` | porta ocupada (4317/4327/4337/4347 e as de login) ou sem espaço em disco; veja a mensagem do `docker compose` |
| o painel não responde | o container ainda sobe, ou caiu: `docker logs <ponte>-opencode-bridge` |
| o login não é detectado | o site mostrou captcha ou verificação; pedir à pessoa que resolva na janela e esperar |
| a ponte logou, mas o teste "pong" falha | site lento ou com tela de aviso; abrir o painel `http://127.0.0.1:<porta api>` e olhar a prévia da tela |
| `Não consegui ler opencode.jsonc` | o arquivo tem JSON inválido; o instalador não altera nada. Mostre o trecho do README ("Registre no opencode.jsonc") à pessoa |
| modelo GT NVIDIA dá "401/403" | chave errada ou de outra conta: a pessoa roda `gt-nvidia-key` de novo |
| modelo GT NVIDIA dá "429" | limite de uso da conta gratuita da NVIDIA naquele minuto; esperar ou trocar de modelo |
| modelo GT NVIDIA dá "404" | a NVIDIA tirou esse modelo do ar; remover de `NVIDIA_MODELS` em `instalar.py` e rodar `--nvidia` de novo |
| GT NVIDIA não aparece no seletor | OpenCode não foi reaberto, ou foi instalado no arquivo do outro sistema (Windows × WSL): rode com o `--config` certo |
| pedidos grandes recusados | o limite padrão é 100.000 caracteres; para subir, ver "As quatro pontes" no README |

## Mais detalhes

- Como tudo funciona e como mexer: [`README.md`](README.md), [`gateway/README.md`](gateway/README.md) e os limites medidos em [`gateway/LIMITES.md`](gateway/LIMITES.md).
- Pontes extras (Qwen, Mistral…) e réplicas são opcionais e ficam fora deste roteiro.
