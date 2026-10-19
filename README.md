# Muse Web → OpenCode

> **Projeto comunitário e não oficial.** A ponte controla um Chromium local para usar a interface web do Muse.ai pelo OpenCode e expõe uma API local compatível com OpenAI. A Meta não mantém nem aprova este projeto. Ele usa a conta pessoal do site, não a Meta Model API; saldo, benefícios, limites e regras continuam vinculados à conta. Mudanças no site podem interromper a automação. Confira os termos atuais e não use o projeto para contornar controles, limites ou restrições.

O Docker Engine, o serviço e o navegador ficam dentro da distro WSL. Não é necessário instalar Docker Desktop. As mensagens passam pela sua instalação local e cada pessoa autentica a própria conta.

## Requisitos

- Windows com WSL 2 e uma distro Ubuntu ou Debian;
- Python 3.10+ e OpenCode (os novos scripts de entrada instalam os requisitos ausentes);
- acesso `sudo` para instalar pacotes do sistema quando o Docker Engine estiver ausente.

## Instalação

No Windows, abra PowerShell na pasta clonada e execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\instalar.ps1
```

O menu permite escolher **OpenCode no Windows/PowerShell** ou **OpenCode no WSL**. Nos dois modos, Chromium e Docker Engine ficam dentro do WSL 2, sem Docker Desktop. No modo Windows o instalador registra o provedor na configuração do usuário Windows e instala Node.js pelo winget e OpenCode pelo npm quando ausentes. No modo WSL, registra o provedor na conta Linux e instala OpenCode pelo script oficial. Instalações existentes do OpenCode são mantidas.

O script usa a distro `Ubuntu`; para uma distro existente com outro nome, use `-Distro Ubuntu-24.04` (consulte `wsl --list`). Se o WSL/distro estiver ausente, ele inicia a instalação e informa quando reiniciar e criar o usuário Linux. Depois execute o script novamente. Ele não cria uma senha Linux por você. No Windows, winget é fornecido pelo App Installer; se ausente, instale-o pela Microsoft Store.

Também é possível baixar apenas `instalar.ps1` do repositório e executá-lo: nesse caso ele clona o projeto em `~/muse-web-opencode-bridge` na distro selecionada. Um checkout já existente é usado diretamente. Instalações por ZIP funcionam, mas a atualização automática requer um clone Git.

No WSL, na pasta clonada, rode:

```bash
bash instalar.sh
```

Esse script instala Python, Git, curl e unzip ausentes em Ubuntu/Debian e chama o instalador. Se já tem os requisitos, pode continuar usando:

```bash
python3 instalar-opencode.py
```

O instalador cria o volume Docker persistente, inicia o backend e registra `muse/muse-web` na configuração global do OpenCode, preservando as demais opções. Ele aceita OpenCode v1 e v2 e cria um backup antes de alterar uma configuração existente. JSONC é salvo como JSON; comentários e formatação originais permanecem no backup. A configuração local contém a chave da ponte e fica com permissão restrita ao seu usuário.

Se o Docker Engine não estiver instalado, o instalador configura o repositório APT oficial do Docker e instala o Engine, o CLI e o plugin Compose dentro do WSL. O APT mostra as alterações e pede confirmação. Para usar Docker sem `sudo`, o script também pede autorização para adicionar seu usuário ao grupo `docker`; esse grupo concede privilégios equivalentes a `root`. Depois disso, feche e reabra o terminal WSL e rode o instalador novamente. O script habilita o serviço no `systemd` quando ele está ativo; sem `systemd`, inicia o daemon para a sessão atual. O Engine e os containers ficam na distro Linux, sem depender do Docker Desktop.

Para iniciar o daemon automaticamente ao iniciar a distro, o WSL precisa usar `systemd`. Se estiver desativado, configure `[boot]` com `systemd=true` em `/etc/wsl.conf` e reinicie o WSL com `wsl.exe --shutdown` no PowerShell; consulte a [documentação da Microsoft sobre systemd no WSL](https://learn.microsoft.com/windows/wsl/systemd). A instalação segue o [repositório APT oficial do Docker](https://docs.docker.com/engine/install/).

Para validar o instalador sem iniciar o Docker nem alterar a configuração do OpenCode:

```bash
python3 instalar-opencode.py --self-test
```

Abra `http://127.0.0.1:4317`. Se precisar entrar na conta, clique em **Abrir Chromium** ou abra a tela remota em `http://127.0.0.1:4318/vnc.html?autoconnect=1&resize=scale&path=websockify`. Conclua o login nessa janela e clique em **Confirmar login**. A API e o painel usam somente endereços locais.

Depois, selecione `muse/muse-web` no OpenCode. O Chromium pode permanecer sem janela aberta, mas o container Docker precisa continuar em execução.

## O que a ponte faz

- `GET /v1/models` lista o modelo `muse-web`.
- `POST /v1/chat/completions` recebe mensagens no formato Chat Completions, incluindo texto, imagens e áudio.
- O serviço envia a mensagem pela interface web autenticada, espera a resposta e a devolve ao OpenCode.
- Para operações locais, o Muse pode solicitar ferramentas que o OpenCode disponibiliza. O OpenCode executa essas ferramentas onde o cliente está rodando (Windows ou WSL), conforme suas permissões; o container não monta nem edita os arquivos do computador diretamente.
- Cada sessão do OpenCode fica associada à sua própria conversa no Muse. A ponte usa uma aba e processa uma solicitação por vez.

As respostas SSE (`stream: true`) só começam a chegar depois que o Muse termina, porque a interface web não fornece tokens intermediários à ponte. `attachments` é uma extensão da resposta OpenAI e pode exigir suporte do cliente para exibir mídia.

Operações normais de ferramentas são solicitadas em JSON dentro de um bloco de código para preservar escapes, aspas e nomes como `__init__`. Uma operação com JSON inválido não é executada: a ponte pede uma correção uma vez e, se ela também falhar, informa o problema ao cliente. Esse erro de formato pode acontecer mesmo em respostas pequenas e não comprova excesso de tamanho.

## Fila e várias sessões

A ponte tem um processo e uma aba do Chromium. A fila local atende em ordem de chegada, com uma chamada em execução e até oito aguardando. Cada execução tem até 180 segundos **a partir da saída da fila**; o tempo de espera tem seu próprio teto de 180 segundos. O cliente pode ter um timeout menor, independentemente desses valores.

Pedidos desconectados saem da espera sem serem enviados ao Muse. A fila cheia retorna `429 queue_full`; espera expirada retorna `503 queue_timeout`. Uma segunda chamada da mesma sessão enquanto a primeira aguarda ou executa recebe `409 session_busy`. O painel e `/control/status` mostram quantas chamadas aguardam; os logs registram `queueWaitMs` no início da execução.

Uma sessão com envio persistido ainda não confirmado recebe `409 submission_pending` para pedidos diferentes, antes de carregar a página. Para recuperar a resposta, repita a solicitação original. A ponte não apaga um pendente apenas pela idade: um timeout não comprova que o envio falhou. A leitura da resposta consulta somente mensagens cujos IDs não existiam antes do envio, evitando extrair novamente o texto do histórico antigo.

A fila HTTP fica em memória; reiniciar desconecta os pedidos aguardando e os clientes precisam tentar novamente. Os envios já iniciados continuam registrados no volume para recuperação, sem reenvio automático. Redis não é necessário para o único processo atual; um broker faria sentido ao separar a API de workers ou compartilhar a fila entre processos. Ele não aumenta a capacidade da aba nem resolve a renderização de conversas grandes.

## Mensagens grandes e integração com Maestro

O limite inicial da ponte é **60.000 caracteres no texto final enviado ao Muse**, somando mensagem, instruções, histórico necessário e catálogo de ferramentas. É uma proteção local configurável, não um limite oficial de tokens ou da conta Muse. A contagem usa unidades UTF-16 (um emoji pode contar como dois). Se o campo do site anunciar um `maxlength` menor, esse limite também é respeitado. O site pode aplicar outras restrições que não publica nesse campo.

Validação em 18/10/2026, pela API da instalação em execução: três chamadas com 32.000, 64.000 e 128.000 caracteres de entrada produziram mensagens de 32.099, 64.099 e 128.099 caracteres na página, todas respondidas com `OK`. A caixa não declarou `maxlength`. Esses testes usaram texto sintético repetitivo, sem catálogo de ferramentas ou histórico extenso: comprovam esses envios, mas não determinam o teto do Muse nem garantem o mesmo resultado com outros conteúdos, contas ou conversas. O limite local de 60.000 permanece provisório; não foi deduzido desses testes.

Antes de preencher a mensagem ou enviar anexos, a ponte rejeita excesso com HTTP `400`:

```json
{"error":{"type":"invalid_request_error","code":"context_length_exceeded","param":"messages","limit_chars":60000,"received_chars":72000,"retryable":false,"message":"...reduza a demanda, o histórico ou os resultados de ferramentas..."}}
```

O cliente Maestro/Maestri deve tratar esse erro e **reformular** a chamada: dividir a tarefa em etapas e reduzir resultados extensos de ferramentas. Repetir o mesmo payload não resolve. O texto digitado pelo usuário pode ser curto enquanto as instruções e ferramentas excedem o limite. A ponte não corta conteúdo nem inventa uma resposta do modelo. Um erro HTTP é recebido pelo cliente; o modelo só recebe essa orientação se o cliente a encaminhar.

Se o próprio Muse exibir uma rejeição explícita de tamanho no envio, a ponte retorna `400` com `code: muse_prompt_too_large` e `suggested_max_prompt_chars` (metade do envio rejeitado, no máximo o limite local). Esse valor é uma sugestão, não uma cota descoberta. Nesse caso remove apenas o marcador pendente para permitir uma versão menor; o histórico permanece. Falhas ambíguas, cotas e timeouts continuam preservados como pendentes.

`GET /v1/models` inclui uma extensão `limits` para clientes consultarem os limites antes de enviar. Continuam valendo até 500 mensagens no array, corpo total de 28 MiB (texto e anexos), mídia de resposta de até 6 MiB por item e 180 segundos por chamada. Corpo maior recebe `413` com `code: request_too_large` e `limit_bytes`, em vez de desconectar sem explicação.

Para ajustar o limite local, crie `.env` na pasta do projeto com `MUSE_MAX_PROMPT_CHARS=60000` e rode o instalador novamente. Aumentar isso não aumenta a capacidade ou a cota do Muse. Use um valor compatível com a interface da sua conta.

Uma tela de login identificada por campos e texto de autenticação usa `code: muse_authentication_required` (`401`). A ausência temporária da caixa de mensagem recebe uma segunda verificação e, se persistir sem evidência de login, retorna `503` com `muse_page_not_ready` e `retryable: true`. Timeouts do navegador usam `muse_page_timeout`; expiração da chamada usa `request_timeout`. Esses casos não são apresentados como perda de login. O cliente deve repetir a mesma solicitação para retomar um envio pendente sem duplicá-lo.

Envios pendentes usam `submission_pending` (`409`). Os logs incluem código e tamanhos quando disponíveis, sem registrar conteúdo das mensagens. Envios incertos continuam preservados para evitar duplicação.

## Atualizar uma instalação

O painel verifica a revisão instalada contra `main` no GitHub ao abrir e a cada hora, e tem o botão **Verificar atualização**. Rede indisponível, limite da API GitHub ou imagem sem revisão produzem estado desconhecido, não uma confirmação falsa de atualização. Uma imagem construída de código modificado localmente não é apresentada como uma revisão publicada.

Pause as demandas no Maestro/OpenCode antes de atualizar. No WSL, dentro da pasta instalada:

```bash
python3 instalar-opencode.py --update
```

No PowerShell, na pasta com o launcher:

```powershell
.\instalar.ps1 -Atualizar
# Para outra distro: .\instalar.ps1 -Atualizar -Distro Ubuntu-24.04
```

O atualizador verifica o `origin` oficial, branch `main`, ausência de alterações locais/arquivos não rastreados e histórico compatível. Então faz fetch e merge `--ff-only`, executa o instalador atualizado e reconstrói o container. Ele recusa chamadas ativas detectadas; mantenha os clientes pausados até terminar. Não faz reset, stash ou exclusão do volume, nem altera a configuração dos clientes Windows/WSL durante atualização.

A imagem anterior fica marcada como `muse-opencode-bridge:rollback`. Se build/inicialização ou a checagem HTTP falhar, o instalador tenta restaurá-la; o checkout continua no código novo. O teste HTTP confirma o painel, não uma resposta real do Muse. Após atualizar, confira o login e faça uma solicitação pequena. O painel não executa comandos Git/Docker e não precisa acessar o socket do daemon.

Exemplo de chamada direta:

```bash
curl http://127.0.0.1:4317/v1/chat/completions \
  -H 'Authorization: Bearer SUA_CHAVE_LOCAL' \
  -H 'Content-Type: application/json' \
  -H 'X-Muse-Session-Id: minha-conversa' \
  -d '{"model":"muse-web","messages":[{"role":"user","content":"Olá"}]}'
```

Clientes diretos devem enviar um `X-Muse-Session-Id` estável para cada conversa. O OpenCode envia seu próprio ID de sessão automaticamente.

## Dados e segurança

O volume Docker `muse-opencode-bridge-data` guarda o perfil autenticado do Chromium, a chave da API local e os vínculos entre sessões e conversas. Mensagens e anexos enviados à ponte são encaminhados ao Muse. A API e a tela remota são publicadas apenas em `127.0.0.1`.

Não compartilhe seu volume Docker, a chave local, a configuração copiada do painel, cookies ou arquivos de sessão. Cada pessoa deve instalar o projeto e autenticar a própria conta. Não exponha as portas em uma rede pública.

O grupo Linux `docker` pode controlar o daemon e, por isso, tem privilégios equivalentes a `root`; veja os [passos pós-instalação do Docker](https://docs.docker.com/engine/install/linux-postinstall/).

Comandos úteis:

```bash
docker compose logs -f
docker compose restart
docker compose down
```

`docker compose down` preserva o volume e a sessão. Para apagar os dados locais, pare o container e remova o volume com `docker volume rm muse-opencode-bridge-data`.

## Testes

```bash
npm test
```

Para validar também o envio pelo Chromium com uma página de teste local, sem conta Muse, use a imagem construída do projeto:

```bash
docker build -t muse-opencode-bridge:test .
docker run --rm --init --network none -e MUSE_BRIDGE_BROWSER_TEST=1 --entrypoint npm muse-opencode-bridge:test test
```

Há também um teste de integração opcional que usa uma sessão autenticada real e envia mensagens ao Muse:

```bash
MUSE_BRIDGE_LIVE_TEST=1 npm test
```

Rode esse teste apenas quando o Docker estiver ativo e não houver outra solicitação em andamento.

Documentação de arquitetura e operação: [docs/ARQUITETURA-E-USO.md](docs/ARQUITETURA-E-USO.md).
