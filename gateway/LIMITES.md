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
| **ChatGPT** | chatgpt-web | 5k–475k | leu os 3, sempre | 36–48 s | 480k |
| | | 500k (2 vezes) | recusado pelo site por tamanho ("recusou a mensagem por tamanho"); a ponte abre conversa nova | 30 s | |
| | | 700k | 409 | 47 s | |
| **Gemini** | gemini-web | 5k | leu os 3 (1ª mensagem após reiniciar) | 16 s | 100k |
| | | 10k–60k, em sequência | **todas falharam**: a página fica "pensando", a URL não vira `/app/<id>`; 3 tentativas cada, ~100 s | 100 s | |

| **Qwen** | qwen-web | 30k / 50k / 70k | leu os 3 | 23–27 s | 70k |
| | | 100k, 250k | **falhou**: o site responde "Running code interpreter…" em vez de ler o texto | 80 s | |
| **Kimi** | kimi-web | 18 s com 30k | leu os 3 | 18 s | 30k+ (50k/70k não medidos) |
| | | 100k | **falhou** (respondeu "Deixa eu verificar a conversa anterior…") | 72 s | |
| | | depois de ~8 chamadas | **cota**: pop-up "Too many people are chatting"; nem "pong" passa. A ponte devolve 429 `provider_quota` | 7 s | |

| **Z.ai** | zai-web | 30k | leu os 3 | 23 s | 30k–100k (não medido entre) |
| | | 100k, 250k | **parcial**: lê início e fim, **perde o meio** (contexto truncado) | 28–99 s | |

## Conclusões

- **DeepSeek**: o mais rápido e o que mais aguenta. Confiável até **~475k** caracteres; 500k é limítrofe; de 600k em diante falha. Acima de ~600k o gargalo é a própria ponte (colar no campo, `browser-operation` de 15 s), não só o site.
- **Muse**: confiável até **480k** (o teto é do container, 500k). Segundo mais capaz, mas estável só depois do primeiro envio.
- **ChatGPT**: leu até **475k**; **500k é recusado pelo próprio site**, de forma reproduzível. Tempo quase constante (36–48 s) de 5k a 475k, ou seja, o custo é a latência fixa do site, não o tamanho. É o mais lento para textos pequenos.
- **Gemini**: **fora da rota (decisão 2026-11-05).** Funciona na 1ª mensagem depois de reiniciar, depois trava. Chromium sem GPU chega a 313% de CPU e 2,4 GB; só 340 MB ao subir. A ponte agora reenvia sozinha se a URL não confirmar em 25 s (`MUSE_SEND_CONFIRM_MS`), mas não resolveu. Ideias: abrir aba nova a cada pedido; bloquear imagens/fontes; Firefox.

O que importa para o Claude Code: o prompt de sistema + ferramentas já ocupa ~100k a 230k, e o histórico cresce a cada turno.
Por isso o tamanho útil de conversa é bem menor que o limite bruto.

- **Qwen** (ponte `universal`, `PROVIDER=qwen`): confiável até **70k**; de 100k em diante o site abre o code interpreter e devolve lixo. Serve para subagentes pequenos.
- **Kimi** (`PROVIDER=kimi`): leu 30k, falhou em 100k. A conta gratuita **esgota rápido**: depois de ~8 chamadas (algumas grandes) o site passou a mostrar "Too many people are chatting" e recusa tudo. A ponte detecta o pop-up e devolve **429 `provider_quota`** (o gateway deve tratar como cota esgotada e usar outra ponte).
- **Z.ai** (`PROVIDER=zai`): leu 30k; a partir de 100k **perde o miolo do texto** sem avisar (pior que falhar, pois a resposta parece válida). Usar só até ~30k.
- Pontes novas usam a imagem única `universal/` (um container por provedor, adaptador em `universal/src/sites/<provedor>.js`).

## Regra de roteamento adotada

Os subagentes do Claude Code costumam pedir o modelo `haiku`; o agente principal pede `sonnet`/`opus`.

| Pedido | Ordem de tentativa | Motivo |
|---|---|---|
| `haiku` (subagentes, tarefas pequenas) | ChatGPT → Muse | poupa DeepSeek; ChatGPT aguenta ~475k mas leva ~40 s por chamada |
| demais (agente principal) | DeepSeek → Muse → ChatGPT | maior capacidade e velocidade primeiro |

Em qualquer caso o gateway pula a ponte cujo limite (`maxChars`) não comporta o prompt, e troca para a próxima se uma falhar
(a que falhou fica 60 s em pausa). Configuração: variáveis `BACKENDS` e `ROUTES` (ver `gateway/README.md`).
