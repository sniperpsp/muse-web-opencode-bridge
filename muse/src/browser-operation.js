export function withBrowserOperationTimeout(operation, { signal, timeoutMs, label, onInterrupt } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Timeout da operação do navegador inválido.");
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("A operação do navegador foi cancelada."));

  let timer;
  let abort;
  const interrupted = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error((label || "A operação no Chromium") + " excedeu " + timeoutMs + " ms."),
      { name: "TimeoutError", code: "muse_browser_operation_timeout", retryable: true },
    )), timeoutMs);
    if (signal) {
      abort = () => reject(signal.reason || Object.assign(new Error("A operação do navegador foi cancelada."), { name: "AbortError" }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
  const running = Promise.resolve().then(() => {
    if (signal?.aborted) throw signal.reason;
    return operation();
  });

  return Promise.race([running, interrupted]).catch(async (error) => {
    if ((signal?.aborted || error.code === "muse_browser_operation_timeout") && onInterrupt) {
      await Promise.resolve(onInterrupt(error)).catch(() => {});
    }
    throw error;
  }).finally(() => {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  });
}
