# Instruções para agentes

- **Pediram para instalar o projeto?** Siga [`INSTALAR.md`](INSTALAR.md). Resumo: pergunte quais sites a pessoa quer, rode `python3 instalar.py --pontes <lista>` em segundo plano, avise que ela deve fazer o login nas janelas que abrirem e acompanhe até a linha `RESULTADO`. Nunca peça nem digite a senha dela.
- **Modelos GT NVIDIA** (10 modelos da API oficial da NVIDIA no seletor do OpenCode, ao lado do GT Auto): seção 2b do [`INSTALAR.md`](INSTALAR.md). A pessoa roda `gt-nvidia-key` no terminal dela (nunca peça a chave no chat); você roda `python3 instalar.py --nvidia` (ou `--com-nvidia` junto com as pontes). Para usar: Ultra 550B = texto/código, Super VL = imagem, Bolt = rápido. Para acrescentar ou trocar modelo: `NVIDIA_MODELS` em `instalar.py` + `python3 -m unittest gateway.test_installer`.
- Visão geral e uso: [`README.md`](README.md). Gateway, roteamento e guardrails: [`gateway/README.md`](gateway/README.md).
- Testes: `node gateway/test.mjs` (gateway), `python3 -m unittest gateway.test_installer` (instalador e perfis NVIDIA) e `npm ci && npm test` dentro de cada ponte.
- Não coloque chaves, `.env` ou `opencode.json*` no repositório.
