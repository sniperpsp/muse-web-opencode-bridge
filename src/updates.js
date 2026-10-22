const REPOSITORY = "sniperpsp/muse-web-opencode-bridge";
let cached;
let expires = 0;
let inFlight;

export async function updateStatus(revision, fetcher = fetch) {
  if (!/^[a-f0-9]{40}$/.test(revision || "")) {
    return { state: "unknown", message: "Esta imagem não registra uma revisão Git. Execute o instalador atualizado para habilitar a verificação." };
  }
  try {
    const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/compare/${revision}...main`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "muse-web-opencode-bridge" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const result = await response.json();
    if (result.status === "ahead") return { state: "available", message: "Há uma atualização disponível no GitHub. Execute o comando de atualização abaixo." };
    if (result.status === "identical") return { state: "current", message: "Sua instalação está atualizada." };
    return { state: "unknown", message: "Esta revisão é local ou diverge do GitHub. Revise o repositório antes de atualizar." };
  } catch {
    return { state: "unknown", message: "Não foi possível verificar o GitHub agora (rede indisponível ou limite da API). Tente novamente mais tarde." };
  }
}

export async function checkUpdate() {
  if (cached && Date.now() < expires) return cached;
  if (!inFlight) inFlight = updateStatus(process.env.MUSE_BUILD_REVISION).then((value) => {
    cached = value;
    expires = Date.now() + (value.state === "unknown" ? 60000 : 3600000);
    return value;
  }).finally(() => { inFlight = undefined; });
  return inFlight;
}
