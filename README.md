# Muse Web → OpenCode

> **Projeto comunitário e não oficial.** A ponte controla um Chromium local para usar a interface web do Muse.ai pelo OpenCode e expõe uma API local compatível com OpenAI. A Meta não mantém nem aprova este projeto. Ele usa a conta pessoal do site, não a Meta Model API; saldo, benefícios, limites e regras continuam vinculados à conta. Mudanças no site podem interromper a automação. Confira os termos atuais e não use o projeto para contornar controles, limites ou restrições.

O serviço e o navegador ficam dentro do Docker. As mensagens passam pela sua instalação local e cada pessoa autentica a própria conta.

## Requisitos

- Windows com WSL 2;
- Python 3 e OpenCode instalados dentro do WSL;
- Docker Desktop com integração WSL e Docker Compose.

## Instalação

Clone o projeto, abra o terminal WSL na pasta clonada e rode:

```bash
python3 instalar-opencode.py
```

O instalador cria o volume Docker persistente, inicia o backend e registra `muse/muse-web` na configuração global do OpenCode, preservando as demais opções. Ele aceita OpenCode v1 e v2 e cria um backup antes de alterar uma configuração existente. JSONC é salvo como JSON; comentários e formatação originais permanecem no backup. A configuração local contém a chave da ponte e fica com permissão restrita ao seu usuário.

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
- Para operações locais, o Muse pode solicitar ferramentas que o OpenCode disponibiliza. O OpenCode executa essas ferramentas no WSL conforme as permissões configuradas no cliente; o container não monta nem edita os arquivos do computador diretamente.
- Cada sessão do OpenCode fica associada à sua própria conversa no Muse. A ponte usa uma aba e processa uma solicitação por vez.

As respostas SSE (`stream: true`) só começam a chegar depois que o Muse termina, porque a interface web não fornece tokens intermediários à ponte. `attachments` é uma extensão da resposta OpenAI e pode exigir suporte do cliente para exibir mídia.

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

Há também um teste de integração opcional que usa uma sessão autenticada real e envia mensagens ao Muse:

```bash
MUSE_BRIDGE_LIVE_TEST=1 npm test
```

Rode esse teste apenas quando o Docker estiver ativo e não houver outra solicitação em andamento.

Documentação de arquitetura e operação: [docs/ARQUITETURA-E-USO.md](docs/ARQUITETURA-E-USO.md).
