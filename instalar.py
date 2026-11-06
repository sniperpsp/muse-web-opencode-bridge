#!/usr/bin/env python3
"""Instalador das pontes web (OpenCode e Claude Code).

Faz, nesta ordem:
  1. confere Docker, Compose e Node;
  2. sobe as pontes escolhidas (docker compose up -d --build);
  3. abre a janela de login de cada uma no seu navegador e espera o login ser detectado;
  4. lê a chave de cada ponte, testa com um "pong" e registra os provedores no opencode.jsonc (com backup);
  5. instala os comandos gt-claude / gt-opencode e o provedor "gateway" (modelo único "GT Auto").

Uso:  python3 instalar.py                         (pergunta o que instalar)
      python3 instalar.py --pontes deepseek,muse   (sem perguntas)
      python3 instalar.py --todas --sem-gateway
      python3 instalar.py --nvidia                 (perfis diretos por modelo, sem gateway)
Pode ser rodado de novo: o que já está de pé, logado ou registrado é pulado.
No Windows, rode dentro do WSL 2.
"""
import argparse
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOME = Path.home()

# Cada ponte: pasta, site, portas (API do OpenCode / tela remota noVNC), modelo e memória aproximada de um container.
BRIDGES = {
    "deepseek": dict(site="DeepSeek", api=4337, vnc=4338, model="deepseek-web", ram="~0,4 GB"),
    "muse": dict(site="Muse AI", api=4317, vnc=4318, model="muse-web", ram="~0,8 GB"),
    "chatgpt": dict(site="ChatGPT", api=4327, vnc=4328, model="chatgpt-web", ram="1,3 a 1,8 GB"),
    "gemini": dict(site="Gemini", api=4347, vnc=4348, model="gemini-web", ram="~1 GB"),
}

NVIDIA_MODELS = [
    ("nvidia-kimi", "moonshotai/kimi-k2.6", "NVIDIA Kimi K2.6"),
    ("nvidia-mistral", "mistralai/mistral-large-4-1t-a52b", "NVIDIA Mistral Large 4"),
    ("nvidia-nemotron-bolt", "nvidia/nemotron-3.5-bolt-e4b", "NVIDIA Nemotron 3.5 Bolt E4B"),
    ("nvidia-minimax", "minimaxai/minimax-m3.1-flash", "NVIDIA MiniMax M3.1 Flash"),
    ("nvidia-deepseek", "deepseek-ai/deepseek-v4.1-flash", "NVIDIA DeepSeek V4.1 Flash"),
    ("nvidia-glm", "z-ai/glm-5.3-flash", "NVIDIA GLM 5.3 Flash"),
    ("nvidia-nemotron-lightning", "nvidia/nemotron-3.5-lightning-30b-a3b", "NVIDIA Nemotron 3.5 Lightning"),
    ("nvidia-nemotron-ultra", "nvidia/nemotron-3-ultra-550b-a55b", "NVIDIA Nemotron 3 Ultra 550B"),
]


def say(msg=""):
    print(msg, flush=True)


def step(msg):
    say(f"\n== {msg}")


def have(cmd):
    return shutil.which(cmd) is not None


def run(cmd, cwd=None, quiet=False):
    return subprocess.run(cmd, cwd=cwd, capture_output=quiet, text=True)


def ask(question, default="s"):
    if not sys.stdin.isatty():
        return default.lower() == "s"
    ans = input(f"{question} [{'S/n' if default.lower() == 's' else 's/N'}] ").strip().lower()
    return (ans or default.lower()).startswith("s")


# ---------- pré-requisitos ----------
def check_prereqs(need_node):
    step("Conferindo o que você já tem")
    problems = []
    if not have("docker"):
        problems.append("Docker não encontrado. Instale o Docker (no Windows, dentro do WSL 2): https://docs.docker.com/engine/install/")
    elif run(["docker", "info"], quiet=True).returncode:
        problems.append("O Docker está instalado, mas não responde. Inicie o serviço (ex.: sudo service docker start) e confira se seu usuário tem acesso.")
    elif run(["docker", "compose", "version"], quiet=True).returncode:
        problems.append("Falta o plugin Docker Compose (comando `docker compose`).")
    if need_node:
        if not have("node"):
            problems.append("Node 18+ não encontrado (necessário só para o gateway). Instale em https://nodejs.org ou use --sem-gateway.")
        else:
            v = run(["node", "--version"], quiet=True).stdout.strip().lstrip("v").split(".")[0]
            if not v.isdigit() or int(v) < 18:
                problems.append(f"Node {v} é antigo; o gateway precisa do 18 ou mais.")
    if problems:
        for p in problems:
            say(f"  ✗ {p}")
        sys.exit(1)
    say("  ✓ Docker, Compose" + (" e Node" if need_node else "") + " ok")


# ---------- navegador ----------
def open_browser(url):
    try:
        if "microsoft" in platform.release().lower() or "microsoft" in Path("/proc/version").read_text(errors="ignore").lower():
            for cmd in (["wslview", url], ["powershell.exe", "-NoProfile", "-Command", f"Start-Process '{url}'"]):
                if have(cmd[0]) and run(cmd, quiet=True).returncode == 0:
                    return True
        for cmd in (["xdg-open", url], ["open", url]):
            if have(cmd[0]) and run(cmd, quiet=True).returncode == 0:
                return True
    except OSError:
        pass
    return False


# ---------- API local de cada ponte ----------
def http(method, url, body=None, headers=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        return 0, ""


def control_token(api):
    status, html = http("GET", f"http://127.0.0.1:{api}/")
    m = re.search(r'const token="([0-9a-f]{32,})"', html) if status == 200 else None
    return m.group(1) if m else None


def control(api, token, method, path, body=None):
    status, raw = http(method, f"http://127.0.0.1:{api}{path}", body if method == "POST" else None, {"x-control-token": token})
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {}


def wait_panel(name, api, seconds=300):
    end = time.time() + seconds
    while time.time() < end:
        tok = control_token(api)
        if tok:
            return tok
        time.sleep(3)
    return None


def bridge_up(name):
    cfg = BRIDGES[name]
    say(f"  → {cfg['site']} (memória: {cfg['ram']})")
    r = run(["docker", "compose", "up", "-d", "--build"], cwd=ROOT / name)
    if r.returncode:
        say(f"  ✗ Falhou subir a ponte {name}. Veja a mensagem acima (porta {cfg['api']} ocupada? sem espaço em disco?).")
        return None
    tok = wait_panel(name, cfg["api"])
    if not tok:
        say(f"  ✗ O painel de {name} não respondeu em http://127.0.0.1:{cfg['api']}. Veja: docker logs {name}-opencode-bridge")
        return None
    say(f"  ✓ {name} no ar: http://127.0.0.1:{cfg['api']}")
    return tok


def login(name, token, open_win=True):
    cfg = BRIDGES[name]
    for _ in range(4):  # a ponte leva alguns segundos para reconhecer um login que já existe
        code, st = control(cfg["api"], token, "GET", "/control/status")
        if st.get("authenticated"):
            say(f"  ✓ {cfg['site']} já está logado")
            return True
        time.sleep(3)
    vnc = f"http://127.0.0.1:{cfg['vnc']}/vnc.html?autoconnect=1&resize=scale&host=127.0.0.1&port={cfg['vnc']}&path=websockify"
    for _ in range(20):  # o Chromium da ponte leva alguns segundos para ficar pronto
        code, _ = control(cfg["api"], token, "POST", "/control/open-auth", {})
        if code == 200:
            break
        time.sleep(3)
    say(f"  Entre na sua conta do {cfg['site']} na janela do Chromium que vai abrir.")
    if open_win and open_browser(vnc):
        say("  (abri a janela no seu navegador)")
    else:
        say(f"  Abra no navegador: {vnc}")
    say("  Se aparecer captcha ou verificação, resolva na mesma janela. Aguardando o login (Ctrl+C pula esta ponte)...")
    try:
        end = time.time() + 900
        warned = False
        while time.time() < end:
            code, st = control(cfg["api"], token, "GET", "/control/status")
            if st.get("authenticated"):
                control(cfg["api"], token, "POST", "/control/complete-login", {})
                say(f"  ✓ Login do {cfg['site']} detectado")
                return True
            if st.get("captcha") and not warned:
                say("  ! O site pediu captcha: resolva o quebra-cabeça na janela.")
                warned = True
            time.sleep(4)
    except KeyboardInterrupt:
        say("\n  pulado")
        return False
    say(f"  ✗ Tempo esgotado esperando o login do {cfg['site']}. Rode o instalador de novo quando quiser.")
    return False


def bridge_key(name):
    r = run(["docker", "exec", f"{name}-opencode-bridge", "cat", "/data/api-key"], quiet=True)
    return r.stdout.strip() if r.returncode == 0 else None


def test_bridge(name, key):
    cfg = BRIDGES[name]
    say(f"  testando {cfg['site']} (pode levar até 1–2 min)...")
    body = {"model": cfg["model"], "messages": [{"role": "user", "content": "Responda apenas: pong"}]}
    code, raw = http("POST", f"http://127.0.0.1:{cfg['api']}/v1/chat/completions", body,
                     {"authorization": f"Bearer {key}", "x-opencode-session-id": "instalador"}, timeout=170)
    ok = code == 200 and "pong" in raw.lower()
    say("  ✓ respondeu" if ok else f"  ! não respondeu como esperado (HTTP {code}); confira o login e tente pelo OpenCode")
    return ok


# ---------- opencode.jsonc ----------
def strip_comments(text):
    return re.sub(r"^\s*//.*$", "", text, flags=re.M)


def provider_block(name, key):
    cfg = BRIDGES[name]
    return {
        "npm": "@ai-sdk/openai-compatible",
        "name": f"{cfg['site']} (navegador local)",
        "options": {"baseURL": f"http://127.0.0.1:{cfg['api']}/v1", "apiKey": key, "timeout": 600000, "headerTimeout": 600000},
        "models": {cfg["model"]: {"name": f"{cfg['site']} Web", "limit": {"context": 128000, "input": 100000, "output": 16000}}},
    }


def gateway_block():
    return {
        "npm": "@ai-sdk/anthropic",
        "name": "GT Pontes Web",
        "options": {"baseURL": "http://127.0.0.1:4350/v1", "apiKey": "{file:~/.config/gateway/key}", "timeout": 600000, "headerTimeout": 600000},
        "models": {"gt-auto": {"name": "GT Auto", "limit": {"context": 80000, "output": 16000}}},
    }


def nvidia_blocks():
    return {
        provider: {
            "npm": "@ai-sdk/openai-compatible",
            "name": label,
            "options": {
                "baseURL": "https://integrate.api.nvidia.com/v1",
                "apiKey": "{file:~/.config/gateway/nvidia.key}",
                "timeout": 600000,
                "headerTimeout": 600000,
            },
            "models": {model: {"name": label, "limit": {"context": 120000, "output": 16000}}},
        }
        for provider, model, label in NVIDIA_MODELS
    }


def remove_legacy_nvidia_provider(text):
    """Remove só o provedor agregado antigo, sem reformatar o JSONC inteiro."""
    parent = re.search(r'"provider"\s*:\s*\{', text)
    if not parent:
        return text, False
    opening = text.find("{", parent.start())
    matches = re.finditer(r'"gateway-nvidia"\s*:\s*\{', text[opening + 1:])
    match = next((item for item in matches if not text[text.rfind("\n", 0, opening + 1 + item.start()) + 1:opening + 1 + item.start()].lstrip().startswith("//")), None)
    if match is None:
        return text, False
    start = opening + 1 + match.start()
    line_start = text.rfind("\n", 0, start) + 1
    if not text[line_start:start].strip(): start = line_start
    value_open = text.find("{", start)
    depth = 0
    quote = False
    escaped = False
    line_comment = False
    block_comment = False
    end = None
    for i in range(value_open, len(text)):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if line_comment:
            if ch == "\n": line_comment = False
            continue
        if block_comment:
            if ch == "*" and nxt == "/": block_comment = False
            continue
        if quote:
            if escaped: escaped = False
            elif ch == "\\": escaped = True
            elif ch == '"': quote = False
            continue
        if ch == "/" and nxt == "/": line_comment = True; continue
        if ch == "/" and nxt == "*": block_comment = True; continue
        if ch == '"': quote = True
        elif ch == "{": depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        raise ValueError("O provedor gateway-nvidia está malformado; configuração preservada.")
    tail = end
    while tail < len(text) and text[tail].isspace(): tail += 1
    if tail < len(text) and text[tail] == ",":
        end = tail + 1
    else:
        # É a última entrada: remove apenas o separador JSONC anterior, fora de strings.
        depth = 0; quote = False; escaped = False; comma = None
        for i in range(opening + 1, start):
            ch = text[i]
            if quote:
                if escaped: escaped = False
                elif ch == "\\": escaped = True
                elif ch == '"': quote = False
            elif ch == '"': quote = True
            elif ch == "{": depth += 1
            elif ch == "}": depth -= 1
            elif ch == "," and depth == 0: comma = i
        if comma is not None:
            start = comma
    updated = text[:start] + text[end:]
    json.loads(strip_comments(updated))
    return updated, True


def register(config_path, blocks):
    """Acrescenta provedores ao opencode.jsonc sem tocar no resto (comentários incluídos). Faz backup e confere o resultado."""
    path = Path(config_path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"$schema": "https://opencode.ai/config.json", "provider": blocks}, indent=2, ensure_ascii=False) + "\n")
        say(f"  ✓ criado {path} com {', '.join(blocks)}")
        return True
    text = path.read_text()
    try:
        current = json.loads(strip_comments(text))
    except ValueError:
        say(f"  ✗ Não consegui ler {path} (JSON inválido). Nada foi alterado. Acrescente os provedores à mão (exemplos no README).")
        return False
    have_prov = current.get("provider", {}) if isinstance(current, dict) else {}
    new = {k: v for k, v in blocks.items() if k not in have_prov}
    for k in blocks:
        if k in have_prov:
            say(f"  = {k} já estava registrado (mantido)")
    if not new:
        return True
    backup = path.with_name(path.name + ".bak-pontes-" + time.strftime("%Y%m%d%H%M%S"))
    shutil.copy2(path, backup)
    body = ",\n".join(f'    {json.dumps(k)}: ' + json.dumps(v, indent=2, ensure_ascii=False).replace("\n", "\n    ") for k, v in new.items())
    m = re.search(r'"provider"\s*:\s*\{', text)
    if m:
        sep = "," if have_prov else ""
        text = text[: m.end()] + "\n" + body + sep + text[m.end():]
    else:
        brace = text.index("{")
        sep = "," if current else ""
        text = text[: brace + 1] + '\n  "provider": {\n' + body + "\n  }" + sep + text[brace + 1:]
    path.write_text(text)
    try:
        after = json.loads(strip_comments(path.read_text()))
        assert all(k in after["provider"] for k in new)
    except Exception:
        shutil.copy2(backup, path)
        say(f"  ✗ O arquivo ficou inválido depois da edição; restaurei o backup ({backup.name}). Registre à mão.")
        return False
    say(f"  ✓ registrado em {path}: {', '.join(new)} (backup: {backup.name})")
    return True


def configure_nvidia_opencode(config_path):
    path = Path(config_path)
    if path.exists():
        original = path.read_text()
        updated, removed = remove_legacy_nvidia_provider(original)
        if removed:
            backup = path.with_name(path.name + ".bak-nvidia-" + time.strftime("%Y%m%d%H%M%S"))
            shutil.copy2(path, backup)
            path.write_text(updated)
            say(f"  ✓ removido o perfil agregado antigo (backup: {backup.name})")
    if not register(path, nvidia_blocks()):
        if path.exists() and "original" in locals():
            path.write_text(original)
        return False
    bindir = HOME / ".local" / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    for name in ("gt-gateway", "gt-nvidia-key"):
        source = ROOT / "gateway" / "scripts" / name
        text = source.read_text().replace("${GT_REPO:-/mnt/e/muse-opencode-bridge}", "${GT_REPO:-" + str(ROOT) + "}")
        target = bindir / name
        target.write_text(text)
        target.chmod(0o755)
    for old in ("gt-nvidia-claude", "gt-nvidia-opencode"):
        (bindir / old).unlink(missing_ok=True)
    say("  ✓ perfis OpenCode conectados diretamente a https://integrate.api.nvidia.com/v1")
    return True


# ---------- gateway ----------
def install_gateway():
    step("Instalando o gateway das pontes web")
    bindir = HOME / ".local" / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    for f in ("gt-gateway", "gt-claude", "gt-opencode"):
        text = (ROOT / "gateway" / "scripts" / f).read_text()
        text = text.replace("${GT_REPO:-/mnt/e/muse-opencode-bridge}", "${GT_REPO:-" + str(ROOT) + "}")  # caminho deste clone
        dest = bindir / f
        dest.write_text(text)
        dest.chmod(0o755)
    say(f"  ✓ comandos copiados para {bindir}")
    cfg = HOME / ".config" / "gateway"
    cfg.mkdir(parents=True, exist_ok=True)
    keyf = cfg / "key"
    if not keyf.exists() or not keyf.read_text().strip():
        keyf.write_text(secrets.token_hex(24) + "\n")
        keyf.chmod(0o600)
        say(f"  ✓ chave do gateway criada em {keyf}")
    if str(bindir) not in os.environ.get("PATH", "").split(os.pathsep):
        say(f'  ! {bindir} não está no seu PATH. Acrescente ao ~/.bashrc:  export PATH="$HOME/.local/bin:$PATH"')


def main():
    ap = argparse.ArgumentParser(description="Instalador das pontes web")
    ap.add_argument("--pontes", help="lista separada por vírgula: " + ",".join(BRIDGES))
    ap.add_argument("--todas", action="store_true", help="instala as quatro pontes")
    ap.add_argument("--sem-gateway", action="store_true", help="não instala o gateway (gt-claude/gt-opencode)")
    ap.add_argument("--sem-abrir", action="store_true", help="não abre o navegador (só mostra os endereços de login)")
    ap.add_argument("--sem-teste", action="store_true", help="não faz a chamada de teste (pong)")
    ap.add_argument("--nvidia", action="store_true", help="configura perfis NVIDIA diretos no OpenCode, sem gateway")
    ap.add_argument("--config", default=str(HOME / ".config" / "opencode" / "opencode.jsonc"), help="arquivo de configuração do OpenCode")
    args = ap.parse_args()

    if args.nvidia:
        step("Configurando modelos NVIDIA diretos no OpenCode")
        if not configure_nvidia_opencode(args.config):
            sys.exit("Não foi possível atualizar a configuração; o arquivo anterior foi preservado.")
        say("RESULTADO " + json.dumps({"perfis_nvidia": [p for p, _, _ in NVIDIA_MODELS], "gateway": False}))
        say("Feche e abra o OpenCode; escolha o perfil NVIDIA desejado no seletor de modelo.")
        return

    say("Instalador das pontes web → OpenCode / Claude Code")
    if args.todas:
        chosen = list(BRIDGES)
    elif args.pontes:
        chosen = [p.strip() for p in args.pontes.split(",") if p.strip()]
        bad = [p for p in chosen if p not in BRIDGES]
        if bad:
            sys.exit(f"Ponte desconhecida: {', '.join(bad)}. Opções: {', '.join(BRIDGES)}")
    else:
        say("\nCada ponte roda um navegador num container e usa a SUA conta no site. Escolha quais instalar:")
        chosen = []
        for name, cfg in BRIDGES.items():
            if ask(f"  {cfg['site']:<9} (memória {cfg['ram']})?", "s" if name in ("deepseek",) else "n"):
                chosen.append(name)
    if not chosen:
        sys.exit("Nenhuma ponte escolhida. Nada a fazer.")
    use_gateway = not args.sem_gateway and (len(chosen) >= 1)

    check_prereqs(need_node=use_gateway)

    step("Subindo as pontes")
    tokens = {n: bridge_up(n) for n in chosen}
    ready = [n for n in chosen if tokens[n]]

    step("Login nos sites")
    say("Vou abrir uma janela por ponte. Faça o login normalmente (e-mail, senha, verificação em duas etapas, captcha).")
    logged = []
    for n in ready:
        say(f"\n[{BRIDGES[n]['site']}]")
        if login(n, tokens[n], open_win=not args.sem_abrir):
            logged.append(n)

    step("Chaves e teste")
    blocks = {}
    for n in logged:
        key = bridge_key(n)
        if not key:
            say(f"  ✗ Não consegui ler a chave de {n}.")
            continue
        blocks[n] = provider_block(n, key)
        if not args.sem_teste:
            test_bridge(n, key)

    step("Registrando no OpenCode")
    if blocks and use_gateway:
        blocks["gateway"] = gateway_block()
    if blocks:
        register(args.config, blocks)
    else:
        say("  nenhuma ponte logada; nada a registrar.")

    if use_gateway and logged:
        install_gateway()

    step("Pronto")
    # linha para agentes lerem: pontes prontas, sem login e se o gateway foi instalado
    say("RESULTADO " + json.dumps({"prontas": logged, "sem_login": [n for n in chosen if n not in logged], "gateway": bool(use_gateway and logged)}))
    skipped = [n for n in chosen if n not in logged]
    if logged:
        say("Pontes prontas: " + ", ".join(BRIDGES[n]["site"] for n in logged))
    if skipped:
        say("Faltou login em: " + ", ".join(BRIDGES[n]["site"] for n in skipped) + " (rode `python3 instalar.py --pontes ...` de novo).")
    if logged:
        say("\nPróximos passos:")
        say("  • OpenCode: feche e abra de novo (ele só lê a configuração ao abrir) e escolha o modelo na lista.")
        if use_gateway:
            say("  • Pelo gateway (roteia entre as pontes, modelo único): gt-opencode   ou   gt-claude")
        say("  • NVIDIA direta no OpenCode, sem gateway: python3 instalar.py --nvidia")
        say("  • Mais pontes, réplicas e ajustes: README.md e gateway/README.md")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nInterrompido.")
