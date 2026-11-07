# Limites medidos das pontes

Teste: `gateway/medir-limite.py` manda um texto de N mil caracteres com três códigos (início, meio e fim) e pede os três de volta.
"Leu" significa que o modelo devolveu os três corretos, não só que a ponte aceitou o texto. Cada tamanho é testado em conversa nova (2026-11-05).

```bash
python3 gateway/medir-limite.py deepseek 100 300 500
```

Cuidado: cada teste consome cota do site.

## Resumo

| Ponte | Leu com segurança até | Tempo típico | Na rota? | Observação |
|---|---|---|---|---|
| DeepSeek | **475k** | 7–21 s | sim, principal (×3) | 500k é limítrofe; de 600k falha |
| Muse | **480k** | 25–27 s | sim (2 abas) | teto do container 500k; estável depois do 1º envio |
| ChatGPT | **475k** | 36–48 s | sim (×2) | 500k é recusado pelo site; o mais lento e o mais pesado (1,3–1,8 GB de RAM) |
| Gemini | **100k** | 15–47 s | sim, por último (×1) | acima de 150k o site corta o final da mensagem |

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

## Notas por ponte

- **DeepSeek:** o mais rápido e o que mais aguenta. Acima de ~600k o gargalo é a própria ponte (colar no campo, `browser-operation` de 15 s), não só o site.
- **Gemini:** a travada antiga vinha da **animação do fundo** da página: sem GPU o Chromium chegava a ~220% de CPU. Com as animações desligadas por CSS injetado (`addInitScript`) e `MUSE_SEND_CONFIRM_MS=60000`, responde em 15–47 s. A mesma injeção está nas pontes DeepSeek, Muse, ChatGPT e Gemini.

## Rota em uso

Modelo único ("GT Auto"); o gateway escolhe pela **demanda** (tamanho da conversa, sem sistema e ferramentas):

| Demanda | Ordem de tentativa |
|---|---|
| qualquer | DeepSeek → Muse → ChatGPT → Gemini |

Cada nome da cadeia vale para a ponte e suas réplicas (DeepSeek ×3, ChatGPT ×2). Falhou (cota, captcha, queda, resposta inválida)? Cai para a próxima.
O gateway pula a ponte cujo limite (`maxChars`) não comporta o prompt, depois de compactar o histórico. Detalhes e variáveis: [`README.md`](README.md).
