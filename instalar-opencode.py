#!/usr/bin/env python3
"""Inicia a ponte local do Muse e registra o provedor no OpenCode."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


PROJECT_DIR = Path(__file__).resolve().parent
VOLUME_NAME = "muse-opencode-bridge-data"
SERVICE_NAME = "muse-bridge"
API_URL = "http://127.0.0.1:4317/v1"
DASHBOARD_URL = "http://127.0.0.1:4317"


class JsoncError(ValueError):
    pass


def parse_jsonc(text):
    """Parse JSONC using the standard library; comments and trailing commas are accepted."""
    uncommented = []
    in_string = escaped = False
    pos = 0
    while pos < len(text):
        char = text[pos]
        if in_string:
            uncommented.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            pos += 1
        elif char == '"':
            in_string = True
            uncommented.append(char)
            pos += 1
        elif text.startswith("//", pos):
            end = text.find("\n", pos + 2)
            end = len(text) if end < 0 else end
            uncommented.extend("\n" if c == "\n" else " " for c in text[pos:end])
            pos = end
        elif text.startswith("/*", pos):
            end = text.find("*/", pos + 2)
            if end < 0:
                raise JsoncError("comentário de bloco sem fechamento")
            end += 2
            uncommented.extend("\n" if c == "\n" else " " for c in text[pos:end])
            pos = end
        else:
            uncommented.append(char)
            pos += 1

    clean = "".join(uncommented)
    without_trailing_commas = []
    in_string = escaped = False
    pos = 0
    while pos < len(clean):
        char = clean[pos]
        if in_string:
            without_trailing_commas.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
            without_trailing_commas.append(char)
        elif char == ",":
            lookahead = pos + 1
            while lookahead < len(clean) and clean[lookahead].isspace():
                lookahead += 1
            if lookahead >= len(clean) or clean[lookahead] not in "]}":
                without_trailing_commas.append(char)
        else:
            without_trailing_commas.append(char)
        pos += 1

    try:
        return json.loads("".join(without_trailing_commas))
    except json.JSONDecodeError as error:
        raise JsoncError(f"configuração inválida na linha {error.lineno}, coluna {error.colno}") from error


def provider_config(version_major, api_key):
    if version_major >= 2:
        return "providers", {
            "name": "Muse (navegador local)",
            "package": "@opencode/ai/providers/openai-compatible",
            "settings": {"baseURL": API_URL, "apiKey": api_key},
            "models": {
                "muse-web": {
                    "name": "Muse Web",
                    "capabilities": {
                        "tools": True,
                        "input": ["text", "image"],
                        "output": ["text"],
                    },
                }
            },
        }
    return "provider", {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Muse (navegador local)",
        "options": {"baseURL": API_URL, "apiKey": api_key},
        "models": {"muse-web": {"name": "Muse Web"}},
    }


def config_path():
    directory = Path.home() / ".config" / "opencode"
    jsonc = directory / "opencode.jsonc"
    json_file = directory / "opencode.json"
    existing = [path for path in (jsonc, json_file) if path.exists()]
    if len(existing) > 1:
        raise RuntimeError(
            f"Encontrei opencode.json e opencode.jsonc em {directory}. "
            "Deixe apenas um arquivo global antes de instalar."
        )
    return existing[0] if existing else jsonc


def update_config(path, providers_key, config_entry):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise RuntimeError(f"Não vou alterar configuração apontada por link simbólico: {path}")
    if path.exists() and not path.is_file():
        raise RuntimeError(f"O caminho da configuração não é um arquivo: {path}")

    original = path.read_text(encoding="utf-8") if path.exists() else "{}\n"
    config = parse_jsonc(original)
    if not isinstance(config, dict):
        raise JsoncError("a raiz da configuração do OpenCode precisa ser um objeto")
    providers = config.setdefault(providers_key, {})
    if not isinstance(providers, dict):
        raise JsoncError(f"a configuração '{providers_key}' existe, mas não é um objeto")
    providers["muse"] = config_entry
    updated = json.dumps(config, ensure_ascii=False, indent=2) + "\n"

    if updated == original:
        os.chmod(path, 0o600)
        return False
    if path.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = path.with_name(f"{path.name}.pre-muse-{stamp}")
        suffix = 1
        while backup.exists():
            backup = path.with_name(f"{path.name}.pre-muse-{stamp}-{suffix}")
            suffix += 1
        shutil.copyfile(path, backup)
        os.chmod(backup, 0o600)

    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    return True


def run(command, *, capture=False):
    return subprocess.run(
        command,
        cwd=PROJECT_DIR,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
    )


def require_command(name):
    if shutil.which(name) is None:
        raise RuntimeError(f"Não encontrei '{name}'. Instale esse requisito e rode o script novamente.")


def wait_for_dashboard():
    for _ in range(60):
        try:
            with urlopen(DASHBOARD_URL, timeout=2) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError, OSError):
            time.sleep(1)
    raise RuntimeError(f"O backend não respondeu em {DASHBOARD_URL} após 60 segundos.")


def read_api_key():
    result = run(["docker", "compose", "exec", "-T", SERVICE_NAME, "cat", "/data/api-key"], capture=True)
    if result.returncode != 0:
        raise RuntimeError("Não consegui ler a chave local do backend no volume Docker.")
    key = result.stdout.strip()
    if len(key) < 16 or any(char.isspace() for char in key):
        raise RuntimeError("A chave local do backend está vazia ou inválida.")
    return key


def self_test():
    source = '''{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    /* preserve this provider */
    "other": { "name": "Other" },
  },
}
'''
    parsed = parse_jsonc(source)
    assert parsed["$schema"] == "https://opencode.ai/config.json"
    assert parsed["providers"]["other"] == {"name": "Other"}

    with tempfile.TemporaryDirectory(prefix="muse-installer-test-") as directory:
        path = Path(directory) / "opencode.jsonc"
        path.write_text(source, encoding="utf-8")
        key_name, entry = provider_config(2, "test-key-only")
        assert update_config(path, key_name, entry)
        saved = parse_jsonc(path.read_text(encoding="utf-8"))
        assert saved["providers"]["other"] == {"name": "Other"}
        assert saved["providers"]["muse"] == entry
        assert path.stat().st_mode & 0o777 == 0o600
        backups = list(path.parent.glob("opencode.jsonc.pre-muse-*"))
        assert len(backups) == 1 and parse_jsonc(backups[0].read_text(encoding="utf-8")) == parsed
        assert not update_config(path, key_name, entry)
        assert len(list(path.parent.glob("opencode.jsonc.pre-muse-*"))) == 1

    key_name, entry = provider_config(1, "test-key-only")
    assert key_name == "provider" and entry["options"]["apiKey"] == "test-key-only"
    print("Autoteste do instalador: OK")


def install():
    if not sys.platform.startswith("linux"):
        raise RuntimeError("Este instalador foi preparado para Linux/WSL.")
    for command in ("docker", "opencode"):
        require_command(command)

    version = run(["opencode", "--version"], capture=True)
    version_text = (version.stdout or version.stderr).strip()
    match = re.search(r"\bv?(\d+)\.", version_text)
    if version.returncode != 0 or not match or int(match.group(1)) not in (1, 2):
        raise RuntimeError(f"Não consegui identificar uma versão compatível do OpenCode: {version_text}")
    major = int(match.group(1))
    if run(["docker", "compose", "version"], capture=True).returncode != 0:
        raise RuntimeError("Docker Compose não encontrado. Ative a integração do Docker Desktop com o WSL.")
    if run(["docker", "info"], capture=True).returncode != 0:
        raise RuntimeError("Docker não está acessível. Abra o Docker Desktop e habilite a integração com o WSL.")

    if run(["docker", "volume", "inspect", VOLUME_NAME], capture=True).returncode != 0:
        if run(["docker", "volume", "create", VOLUME_NAME], capture=True).returncode != 0:
            raise RuntimeError("Não consegui criar o volume persistente do Chromium e da chave local.")

    print("Iniciando o backend Muse no Docker…")
    if run(["docker", "compose", "up", "--build", "-d"]).returncode != 0:
        raise RuntimeError("Docker Compose não conseguiu iniciar o backend.")
    wait_for_dashboard()

    key_name, entry = provider_config(major, read_api_key())
    target = config_path()
    changed = update_config(target, key_name, entry)
    print("Backend respondendo em http://127.0.0.1:4317.")
    print(f"OpenCode {'configurado' if changed else 'já estava configurado'} em {target}.")
    print("A chave local foi gravada sem ser exibida e com permissão privada.")
    print("\nPróximos passos:")
    print(f"1. Abra {DASHBOARD_URL} no navegador.")
    print("2. Entre na sua própria conta Muse pelo botão Abrir Chromium e confirme o login.")
    print("3. Reabra o OpenCode e selecione muse/muse-web.")
    print("Não compartilhe o volume Docker nem a chave local; cada computador usa sua própria conta.")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:]:
        print(f"Uso: {Path(sys.argv[0]).name} [--self-test]", file=sys.stderr)
        return 2
    try:
        install()
    except (JsoncError, OSError, RuntimeError) as error:
        print(f"Instalação não concluída: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
