# Instruções para agentes

- **Pediram para instalar o projeto?** Siga [`INSTALAR.md`](INSTALAR.md). Resumo: pergunte quais sites a pessoa quer, rode `python3 instalar.py --pontes <lista>` em segundo plano, avise que ela deve fazer o login nas janelas que abrirem e acompanhe até a linha `RESULTADO`. Nunca peça nem digite a senha dela.
- Visão geral e uso: [`README.md`](README.md). Gateway, roteamento e guardrails: [`gateway/README.md`](gateway/README.md).
- Testes: `node gateway/test.mjs` (gateway) e `npm ci && npm test` dentro de cada ponte.
- Não coloque chaves, `.env` ou `opencode.json*` no repositório.
