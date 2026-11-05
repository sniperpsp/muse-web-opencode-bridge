# Limites medidos das pontes

Teste: `gateway/medir-limite.py` manda um texto de N mil caracteres com três códigos (início, meio e fim) e pede os três de volta.
"Leu" significa que o modelo devolveu os três corretos, não só que a ponte aceitou o texto. Cada tamanho é testado em conversa nova (2026-11-05).

```bash
# pontes registradas no opencode.jsonc
python3 gateway/medir-limite.py deepseek 100 300 500
# pontes fora do opencode.jsonc
BASE=http://127.0.0.1:4361/v1 KEY=<chave da ponte> MODEL=qwen-web python3 gateway/medir-limite.py qwen 30 70
```

Cuidado: cada teste consome cota do site (Kimi esgotou em ~8 chamadas; MiniMax gasta créditos por tarefa).

## Resumo

| Ponte | Leu com segurança até | Tempo típico | Na rota? | Observação |
|---|---|---|---|---|
| DeepSeek | **475k** | 7–21 s | sim, principal (×3) | 500k é limítrofe; de 600k falha |
| Muse | **480k** | 25–27 s | sim (2 abas) | teto do container 500k; estável depois do 1º envio |
| ChatGPT | **475k** | 36–48 s | sim (×2) | 500k é recusado pelo site; o mais lento e o mais pesado (1,3–1,8 GB de RAM) |
| Gemini | **100k** | 15–47 s | sim, por último (×1) | acima de 150k o site corta o final da mensagem |
| Mistral | 60k | 16 s | sim, só conversa pequena | em 100k o site corta o miolo e avisa |
| Qwen | 70k | 23–27 s | sim, só conversa pequena | em 100k+ o site abre o code interpreter e devolve lixo |
| MiniMax | ~90k | 6–12 s | não (opcional) | é um agente: gasta créditos (400/dia); captcha trava a página |
| Z.ai | 30k | 23 s | não | de 100k perde o miolo **sem avisar** |
| Kimi | 30k | 18 s | não | cota gratuita esgota em ~8 chamadas (pop-up "Too many people are chatting") |
| Duck.ai | 10k | 5 s | não | o site limita a mensagem a 16.000 caracteres; sem login |
| Copilot | — | — | não | a Microsoft bloqueia o login no Chromium automatizado |

O prompt fixo do Claude Code e do OpenCode (sistema + ferramentas) já ocupa ~30k a 230k, e o histórico cresce a cada turno. O tamanho útil de conversa é bem menor que o limite bruto, e o gateway compacta o histórico quando passa (ver `README.md`).

## Resultados detalhados

| Ponte | Tamanho | Resultado | Tempo |
|---|---|---|---|
| DeepSeek | 20k–475k | leu os 3, sempre | 7–21 s |
| | 500k | 1ª vez 409, 2ª vez leu os 3 | 27–38 s |
| | 600k | 409 | 29 s |
| | 700k | 503: a ponte levou mais de 15 s só para colar o texto no campo | 14 s |
| Muse | 150k, 300k, 480k | leu os 3, sempre | 25–27 s |
| | 1º envio de 20k | 502 uma vez: botão de envio não achado | 3 s |
| ChatGPT | 5k–475k | leu os 3, sempre | 36–48 s |
| | 500k (2 vezes) | recusado pelo site por tamanho; a ponte abre conversa nova | 30 s |
| | 700k | 409 | 47 s |
| Gemini | 30k | leu os 3 | 15 s |
| | 100k | leu os 3 | 47 s |
| | 150k, 250k, 450k | falhou: o site corta o final da mensagem colada | 22–101 s |
| Qwen | 30k, 50k, 70k | leu os 3 | 23–27 s |
| | 100k, 250k | falhou: "Running code interpreter…" | 80 s |
| Mistral | 30k, 60k | leu os 3 | 16 s |
| | 100k | parcial: "[... 5002 caracteres omitidos]"; perde o meio | 35 s |
| MiniMax | 30k | leu os 3 | 6 s |
| | 90k | leu os 3 (depois de resolver o captcha) | 12 s |
| | 95k, antes do captcha | travou: sem resolver o captcha, fica "Processing" para sempre | >240 s |
| | 200k | não confirmou (envio sem endereço em 15 s) | — |
| Z.ai | 30k | leu os 3 | 23 s |
| | 100k, 250k | parcial: lê início e fim, perde o meio | 28–99 s |
| Kimi | 30k | leu os 3 | 18 s |
| | 100k | falhou ("Deixa eu verificar a conversa anterior…") | 72 s |
| | depois de ~8 chamadas | cota: nem "pong" passa; a ponte devolve 429 `provider_quota` | 7 s |
| Duck.ai | 6k, 10k | leu os 3 | 5 s |
| | 12k | perdeu o código do meio | 6 s |
| | 30k, 100k | recusado pelo site (16.000 caracteres) | 18 s |

## Notas por ponte

- **DeepSeek:** o mais rápido e o que mais aguenta. Acima de ~600k o gargalo é a própria ponte (colar no campo, `browser-operation` de 15 s), não só o site.
- **Gemini:** a travada antiga vinha da **animação do fundo** da página: sem GPU o Chromium chegava a ~220% de CPU. Com as animações desligadas por CSS injetado (`addInitScript`) e `MUSE_SEND_CONFIRM_MS=60000`, responde em 15–47 s. A mesma injeção está nas pontes DeepSeek, Muse, ChatGPT e Gemini.
- **Mistral e Qwen:** adaptadores em `universal/src/sites/`; entram no gateway só para conversas pequenas, com falha caindo para as pontes grandes.
- **MiniMax:** com texto grande ele corta a colagem e roda comandos para reconstruí-la, o que gasta muitos créditos. Não rode testes grandes automáticos.
- **Kimi:** a ponte detecta o pop-up de fila e devolve 429 `provider_quota`.
- **Duck.ai:** no primeiro uso é preciso clicar "Continue" nos termos. A conversa continua na mesma página (a URL não muda). Container com `MUSE_MAX_PROMPT_CHARS=15000`.
- **Copilot:** alternativa não implementada: ligar o Chrome do Windows já logado via `MUSE_CDP_ENDPOINT`.

## Rota em uso

Modelo único ("GT Auto"); o gateway escolhe pela **demanda** (tamanho da conversa, sem sistema e ferramentas):

| Demanda | Ordem de tentativa |
|---|---|
| até 6000 chars | Mistral → Qwen → DeepSeek → Muse → ChatGPT → Gemini |
| acima | DeepSeek → Muse → ChatGPT → Gemini |

Cada nome da cadeia vale para a ponte e suas réplicas (DeepSeek ×3, ChatGPT ×2). Falhou (cota, captcha, queda, resposta inválida)? Cai para a próxima. A cadeia sempre termina nas pontes grandes.
O gateway pula a ponte cujo limite (`maxChars`) não comporta o prompt, depois de compactar o histórico. Detalhes e variáveis: [`README.md`](README.md).
