// ponytail: one process owns one browser tab; a shared broker is needed only for multiple workers.
export function createRequestQueue({ maxWaiting = 8, waitTimeoutMs = 180000 } = {}) {
  const waiting = [];
  let active;
  const error = (message, status, code) => Object.assign(new Error(message), { status, code, retryable: true });

  function pump() {
    if (active || !waiting.length) return;
    active = waiting.shift();
    const entry = active;
    entry.cleanup();
    Promise.resolve().then(() => {
      entry.signal?.throwIfAborted();
      return entry.task(Date.now() - entry.queuedAt);
    }).then(entry.resolve, entry.reject).finally(() => { active = undefined; pump(); });
  }

  return {
    status: () => ({ waiting: waiting.length, active_session: active?.sessionId || null, oldest_wait_ms: waiting.length ? Date.now() - waiting[0].queuedAt : 0 }),
    run(task, { sessionId, signal } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (sessionId && (active?.sessionId === sessionId || waiting.some((entry) => entry.sessionId === sessionId))) {
        return Promise.reject(error("Esta sessão já tem uma chamada na fila ou em execução. Aguarde a resposta antes de enviar outra; a nova chamada não foi enviada ao Muse.", 409, "session_busy"));
      }
      if (active && waiting.length >= maxWaiting) return Promise.reject(error("A fila da ponte está cheia. Aguarde e repita a mesma solicitação; ela não foi enviada ao Muse.", 429, "queue_full"));
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
