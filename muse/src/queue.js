// Até `concurrency` chamadas rodam ao mesmo tempo, cada uma em um slot (uma aba do Muse). Dentro de uma sessão a ordem é sempre sequencial.
export function createRequestQueue({ maxWaiting = 8, waitTimeoutMs = 180000, concurrency = 1 } = {}) {
  const waiting = [];
  const active = new Set();
  const lastSlot = new Map();
  const error = (message, status, code) => Object.assign(new Error(message), { status, code, retryable: true });

  function pickSlot(sessionId) {
    const used = new Set([...active].map((entry) => entry.slot));
    const preferred = lastSlot.get(sessionId);
    if (preferred !== undefined && !used.has(preferred)) return preferred;
    for (let slot = 0; slot < concurrency; slot++) if (!used.has(slot)) return slot;
  }

  function pump() {
    while (active.size < concurrency && waiting.length) {
      const entry = waiting.shift();
      entry.cleanup();
      entry.slot = pickSlot(entry.sessionId);
      if (entry.sessionId) lastSlot.set(entry.sessionId, entry.slot);
      active.add(entry);
      Promise.resolve().then(() => {
        entry.signal?.throwIfAborted();
        return entry.task(Date.now() - entry.queuedAt, entry.slot);
      }).then(entry.resolve, entry.reject).finally(() => { active.delete(entry); pump(); });
    }
  }

  const sessionBusy = (sessionId) => [...active, ...waiting].some((entry) => entry.sessionId === sessionId);

  return {
    status: () => ({ waiting: waiting.length, active: active.size, concurrency, active_session: [...active][0]?.sessionId || null, oldest_wait_ms: waiting.length ? Date.now() - waiting[0].queuedAt : 0 }),
    run(task, { sessionId, signal } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (sessionId && sessionBusy(sessionId)) {
        return Promise.reject(error("Esta sessão já tem uma chamada na fila ou em execução. Aguarde a resposta antes de enviar outra; a nova chamada não foi enviada ao Muse.", 503, "session_busy"));
      }
      if (active.size >= concurrency && waiting.length >= maxWaiting) return Promise.reject(error("A fila da ponte está cheia. Aguarde e repita a mesma solicitação; ela não foi enviada ao Muse.", 429, "queue_full"));
      return new Promise((resolve, reject) => {
        const entry = { task, sessionId, signal, resolve, reject, queuedAt: Date.now() };
        const cancel = (reason) => {
          const index = waiting.indexOf(entry);
          if (index < 0) return;
          waiting.splice(index, 1);
          entry.cleanup();
          reject(reason);
        };
        const aborted = () => cancel(signal.reason);
        const timer = setTimeout(() => cancel(error("O pedido atingiu o tempo máximo de espera na fila, antes de executar. Ele não foi enviado ao Muse; aguarde e tente novamente.", 503, "queue_timeout")), waitTimeoutMs);
        entry.cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); };
        signal?.addEventListener("abort", aborted, { once: true });
        waiting.push(entry);
        pump();
      });
    },
  };
}
