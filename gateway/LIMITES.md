# Limites medidos das pontes

Teste: `gateway/medir-limite.py` manda um texto de N mil caracteres com três códigos (início, meio e fim) e
pede os três de volta. "Leu" significa que o modelo devolveu os três corretos, não só que a ponte aceitou o texto.
Medido em 2026-11-05, cada tamanho em conversa nova.

| Ponte | Modelo | Tamanho testado | Resultado | Tempo | Limite configurado |
|---|---|---|---|---|---|
| **DeepSeek** | deepseek-web | 20k–475k | leu os 3, sempre | 7–21 s | (ajustável) |
| | | 500k | 1ª vez 409, 2ª vez leu os 3 | 27–38 s | |
| | | 600k | 409 (falhou) | 29 s | |
| | | 700k | 503: a ponte levou >15 s só para colar o texto no campo | 14 s | |
| **Muse** | muse-web | 150k, 300k, 480k | leu os 3, sempre | 25–27 s | 500k |
| | | (1º envio de 20k) | 502 uma vez: botão de envio não achado | 3 s | |
| **ChatGPT** | chatgpt-web | 20k, 90k | leu os 3 | ~40 s | 100k |
| **Gemini** | gemini-web | 5k | leu os 3 (1ª mensagem após reiniciar) | 16 s | 100k |
| | | 10k–60k, em sequência | **todas falharam**: a página fica "pensando", a URL não vira `/app/<id>`; 3 tentativas cada, ~100 s | 100 s | |

## Conclusões

- **DeepSeek**: o mais rápido e o que mais aguenta. Confiável até **~475k** caracteres; 500k é limítrofe; de 600k em diante falha. Acima de ~600k o gargalo é a própria ponte (colar no campo, `browser-operation` de 15 s), não só o site.
- **Muse**: confiável até **480k** (o teto é do container, 500k). Segundo mais capaz, mas estável só depois do primeiro envio.
- **ChatGPT**: leu até **90k**; o teto é 100k, então o limite real do site não foi medido. É o mais lento (~40 s), mesmo com texto pequeno.
- **Gemini**: **fora da rota (decisão 2026-11-05).** Funciona na 1ª mensagem depois de reiniciar, depois trava. Chromium sem GPU chega a 313% de CPU e 2,4 GB; só 340 MB ao subir. A ponte agora reenvia sozinha se a URL não confirmar em 25 s (`MUSE_SEND_CONFIRM_MS`), mas não resolveu. Ideias: abrir aba nova a cada pedido; bloquear imagens/fontes; Firefox.
- Limite real do **ChatGPT** ainda não medido (só até 90k, teto 100k): exige subir `MUSE_MAX_PROMPT_CHARS` e recriar o container.

O que importa para o Claude Code: o prompt de sistema + ferramentas já ocupa ~100k a 230k, e o histórico cresce a cada turno.
Por isso o tamanho útil de conversa é bem menor que o limite bruto.

## Regra de roteamento adotada

Os subagentes do Claude Code costumam pedir o modelo `haiku`; o agente principal pede `sonnet`/`opus`.

| Pedido | Ordem de tentativa | Motivo |
|---|---|---|
| `haiku` (subagentes, tarefas pequenas) | ChatGPT → Muse | prompts menores; poupa a ponte mais capaz |
| demais (agente principal) | DeepSeek → Muse → ChatGPT | maior capacidade e velocidade primeiro |

Em qualquer caso o gateway pula a ponte cujo limite (`maxChars`) não comporta o prompt, e troca para a próxima se uma falhar
(a que falhou fica 60 s em pausa). Configuração: variáveis `BACKENDS` e `ROUTES` (ver `gateway/README.md`).
