#!/usr/bin/env python3
"""Inicia a ponte local do Muse e registra o provedor no OpenCode."""

import json
import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import Request, urlopen


PROJECT_DIR = Path(__file__).resolve().parent
VOLUME_NAME = "muse-opencode-bridge-data"
SERVICE_NAME = "muse-bridge"
API_URL = "http://127.0.0.1:4317/v1"
DASHBOARD_URL = "http://127.0.0.1:4317"
DOCKER_APT_SOURCE_FILE = Path("/etc/apt/sources.list.d/docker.sources")


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


def config_path(directory=None):
    directory = directory or Path.home() / ".config" / "opencode"
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


def ensure_opencode():
    os.environ["PATH"] = str(Path.home() / ".opencode" / "bin") + os.pathsep + os.environ.get("PATH", "")
    if shutil.which("opencode"):
        return
    for name in ("curl", "unzip"):
        require_command(name)
    print("Instalando OpenCode pelo instalador oficial…")
    with tempfile.TemporaryDirectory(prefix="muse-opencode-install-") as directory:
        script = Path(directory) / "install.sh"
        run_or_raise(["curl", "-fsSL", "https://opencode.ai/v2/install", "-o", str(script)], "Não consegui baixar o instalador do OpenCode.")
        run_or_raise(["bash", str(script)], "A instalação do OpenCode falhou.")
    require_command("opencode")


def update_repository():
    require_command("git")
    def git(*args):
        result = run(["git", *args], capture=True)
        if result.returncode:
            raise RuntimeError(f"Git não conseguiu executar {args[0]}. Revise o repositório e a conexão.")
        return result.stdout.strip()
    origin = git("remote", "get-url", "origin").removesuffix(".git").rstrip("/")
    if origin not in {"https://github.com/sniperpsp/muse-web-opencode-bridge", "git@github.com:sniperpsp/muse-web-opencode-bridge"}:
        raise RuntimeError("Atualização automática exige origin apontando para o repositório oficial.")
    if git("branch", "--show-current") != "main" or git("status", "--porcelain"):
        raise RuntimeError("Atualização exige branch main sem arquivos modificados ou não rastreados. Preserve suas alterações antes de continuar.")
    git("fetch", "origin", "main:refs/remotes/origin/main")
    git("merge-base", "--is-ancestor", "HEAD", "origin/main")
    git("merge", "--ff-only", "origin/main")
    # Re-enter the newly fetched installer; existing Windows/WSL client configs stay valid.
    os.execv(sys.executable, [sys.executable, str(PROJECT_DIR / "instalar-opencode.py"), "--backend-only"])


def is_wsl2():
    try:
        release = Path("/proc/sys/kernel/osrelease").read_text(encoding="utf-8").casefold()
    except OSError:
        return False
    return "microsoft" in release and ("wsl2" in release or "microsoft-standard" in release)


def docker_apt_source(distribution, suite, architecture):
    if distribution not in {"ubuntu", "debian"}:
        raise RuntimeError("A instalação automática do Docker Engine suporta Ubuntu ou Debian no WSL 2.")
    if not re.fullmatch(r"[a-z][a-z0-9.-]*", suite):
        raise RuntimeError("Não consegui identificar a versão da distro para configurar o repositório Docker.")
    if architecture not in {"amd64", "arm64", "armhf", "ppc64el", "s390x"}:
        raise RuntimeError(f"A arquitetura '{architecture}' não é suportada pelo repositório Docker.")
    return (
        "Types: deb\n"
        f"URIs: https://download.docker.com/linux/{distribution}\n"
        f"Suites: {suite}\n"
        "Components: stable\n"
        f"Architectures: {architecture}\n"
        "Signed-By: /etc/apt/keyrings/docker.asc\n"
    )


def systemd_available():
    return Path("/run/systemd/system").is_dir()


def run_or_raise(command, message):
    if run(command).returncode != 0:
        raise RuntimeError(message)


def install_docker_engine():
    if not is_wsl2():
        raise RuntimeError("Docker Engine requer WSL 2. Confira com 'wsl.exe -l -v' no Windows.")
    if os.geteuid() == 0:
        raise RuntimeError("Rode este instalador como seu usuário normal do WSL, sem sudo; ele pedirá sudo quando precisar.")
    for command in ("sudo", "apt-get", "dpkg"):
        require_command(command)

    try:
        os_release = platform.freedesktop_os_release()
    except OSError as error:
        raise RuntimeError("Não consegui ler a identificação da distro Linux.") from error
    distribution = os_release.get("ID", "").lower()
    suite = (os_release.get("UBUNTU_CODENAME") if distribution == "ubuntu" else os_release.get("VERSION_CODENAME", ""))
    architecture = run(["dpkg", "--print-architecture"], capture=True)
    if architecture.returncode != 0:
        raise RuntimeError("Não consegui identificar a arquitetura do WSL.")
    source = docker_apt_source(distribution, suite or "", architecture.stdout.strip())
    repository_file = DOCKER_APT_SOURCE_FILE
    if repository_file.exists() and repository_file.read_text(encoding="utf-8") != source:
        raise RuntimeError("Já existe uma configuração diferente em /etc/apt/sources.list.d/docker.sources; revise-a antes de continuar.")

    print("Instalando Docker Engine e o plugin Docker Compose dentro desta distro WSL…")
    run_or_raise(["sudo", "apt-get", "update"], "Não consegui atualizar os índices do APT.")
    run_or_raise(
        ["sudo", "apt-get", "install", "-y", "ca-certificates", "curl"],
        "Não consegui instalar os certificados e o curl necessários.",
    )
    run_or_raise(
        ["sudo", "install", "-m", "0755", "-d", "/etc/apt/keyrings"],
        "Não consegui preparar o diretório de chaves do APT.",
    )
    run_or_raise(
        ["sudo", "curl", "-fsSL", f"https://download.docker.com/linux/{distribution}/gpg", "-o", "/etc/apt/keyrings/docker.asc"],
        "Não consegui baixar a chave oficial do repositório Docker.",
    )
    run_or_raise(
        ["sudo", "chmod", "a+r", "/etc/apt/keyrings/docker.asc"],
        "Não consegui ajustar a permissão da chave do repositório Docker.",
    )

    if not repository_file.exists():
        with tempfile.TemporaryDirectory(prefix="muse-docker-apt-") as directory:
            source_path = Path(directory) / "docker.sources"
            source_path.write_text(source, encoding="utf-8")
            run_or_raise(
                ["sudo", "install", "-m", "0644", str(source_path), str(repository_file)],
                "Não consegui configurar o repositório oficial do Docker.",
            )

    run_or_raise(["sudo", "apt-get", "update"], "Não consegui atualizar os índices do repositório Docker.")
    run_or_raise(
        ["sudo", "apt-get", "install", "docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"],
        "A instalação dos pacotes Docker falhou. Revise a saída do APT e tente novamente.",
    )

    groups = run(["id", "-nG"], capture=True)
    if groups.returncode != 0:
        raise RuntimeError("Não consegui verificar os grupos do usuário atual.")
    membership_changed = "docker" not in groups.stdout.split()
    if membership_changed:
        print("O grupo 'docker' permite usar o daemon sem sudo e concede privilégios equivalentes a root.")
        if input("Adicionar seu usuário a esse grupo? [S/n] ").strip().casefold() in {"n", "nao", "não"}:
            raise RuntimeError('Docker instalado, mas o OpenCode precisa do grupo docker. Execute `sudo usermod -aG docker "$USER"` e rode novamente.')
        user = run(["id", "-un"], capture=True)
        username = user.stdout.strip()
        if user.returncode != 0 or not username or not re.fullmatch(r"[a-zA-Z0-9_.-]+", username):
            raise RuntimeError("Não consegui identificar com segurança o usuário atual do WSL.")
        run_or_raise(
            ["sudo", "usermod", "-aG", "docker", username],
            "Não consegui adicionar o usuário atual ao grupo docker.",
        )

    if systemd_available():
        run_or_raise(["sudo", "systemctl", "enable", "--now", "docker"], "Não consegui iniciar o serviço Docker com systemd.")
    else:
        run_or_raise(["sudo", "service", "docker", "start"], "Não consegui iniciar o serviço Docker nesta distro WSL.")
        print("systemd não está ativo; o daemon precisará ser iniciado com 'sudo service docker start' após reiniciar o WSL.")
    return membership_changed


def ensure_docker():
    if shutil.which("docker") is None:
        print("Docker Engine não encontrado nesta distro WSL.")
        membership_changed = install_docker_engine()
        if membership_changed:
            print("\nFeche e reabra a distro WSL para ativar o grupo docker e rode novamente este instalador.")
            return False
        return True
    return True


def ensure_docker_daemon():
    result = run(["docker", "info"], capture=True)
    if result.returncode == 0:
        return
    if "permission denied" in (result.stderr or "").casefold():
        raise RuntimeError("Sem acesso ao daemon Docker. Entre no grupo docker e reabra a sessão WSL.")
    service = ["sudo", "systemctl", "start", "docker"] if systemd_available() else ["sudo", "service", "docker", "start"]
    if shutil.which("sudo") is not None:
        run(service)
        result = run(["docker", "info"], capture=True)
    if result.returncode != 0:
        raise RuntimeError("Docker Engine não está acessível. Confira se o serviço docker está iniciado nesta distro WSL.")


def wait_for_dashboard():
    for _ in range(60):
        try:
            with urlopen(DASHBOARD_URL, timeout=2) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError, OSError):
            time.sleep(1)
    raise RuntimeError(f"O backend não respondeu em {DASHBOARD_URL} após 60 segundos.")


def ensure_backend_idle():
    try:
        with urlopen(DASHBOARD_URL, timeout=3) as response:
            html = response.read().decode("utf-8")
    except (URLError, OSError):
        return  # An offline backend can still be updated/repaired.
    match = re.search(r'const token=("[a-f0-9]+");const config=', html)
    if not match:
        raise RuntimeError("Não consegui consultar o estado da instalação ativa. Pare as tarefas e o backend antes de atualizar.")
    request = Request(DASHBOARD_URL + "/control/status", headers={"X-Control-Token": json.loads(match[1])})
    with urlopen(request, timeout=15) as response:
        status = json.load(response)
    if status.get("request") or status.get("queue", {}).get("waiting"):
        raise RuntimeError("Há uma chamada em andamento. Pause o Maestro/OpenCode e aguarde a resposta antes de atualizar.")


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

    module = sys.modules[__name__]
    assert docker_apt_source("ubuntu", "noble", "amd64") == (
        "Types: deb\n"
        "URIs: https://download.docker.com/linux/ubuntu\n"
        "Suites: noble\n"
        "Components: stable\n"
        "Architectures: amd64\n"
        "Signed-By: /etc/apt/keyrings/docker.asc\n"
    )
    commands = []
    sources = []

    def fake_run(command, *, capture=False):
        commands.append(command)
        if command == ["dpkg", "--print-architecture"]:
            return SimpleNamespace(returncode=0, stdout="amd64\n", stderr="")
        if command == ["id", "-nG"]:
            return SimpleNamespace(returncode=0, stdout="bridge-test\n", stderr="")
        if command == ["id", "-un"]:
            return SimpleNamespace(returncode=0, stdout="bridge-test\n", stderr="")
        if command[:3] == ["sudo", "install", "-m"] and command[-1] == str(module.DOCKER_APT_SOURCE_FILE):
            sources.append(Path(command[-2]).read_text(encoding="utf-8"))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    with tempfile.TemporaryDirectory(prefix="muse-installer-docker-test-") as directory:
        repo_file = Path(directory) / "docker.sources"
        with (
            patch.object(module, "is_wsl2", return_value=True),
            patch.object(module, "systemd_available", return_value=True),
            patch.object(module, "DOCKER_APT_SOURCE_FILE", repo_file),
            patch.object(platform, "freedesktop_os_release", return_value={"ID": "ubuntu", "UBUNTU_CODENAME": "noble"}),
            patch.object(shutil, "which", return_value="/usr/bin/sudo"),
            patch.object(os, "geteuid", return_value=1000),
            patch("builtins.input", return_value=""),
            patch("builtins.print"),
            patch.object(module, "run", side_effect=fake_run),
        ):
            assert install_docker_engine() is True
        assert sources == [docker_apt_source("ubuntu", "noble", "amd64")]
    assert ["sudo", "apt-get", "install", "docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"] in commands
    assert ["sudo", "usermod", "-aG", "docker", "bridge-test"] in commands
    assert ["sudo", "systemctl", "enable", "--now", "docker"] in commands

    with (
        patch.object(shutil, "which", return_value=None),
        patch.object(module, "install_docker_engine", return_value=True),
        patch("builtins.print"),
    ):
        assert ensure_docker() is False

    for dirty, remote, branch, diverged in [(True, False, False, False), (False, True, False, False), (False, False, True, False), (False, False, False, True), (False, False, False, False)]:
        calls = []
        def fake_git(command, **kwargs):
            calls.append(command)
            output = ""
            if command[1:3] == ["remote", "get-url"]:
                output = "https://github.com/other/repo" if remote else "https://github.com/sniperpsp/muse-web-opencode-bridge.git"
            elif command[1:3] == ["branch", "--show-current"]:
                output = "feature" if branch else "main"
            elif command[1:3] == ["status", "--porcelain"]:
                output = " M README.md" if dirty else ""
            return SimpleNamespace(returncode=int(diverged and command[1] == "merge-base"), stdout=output, stderr="")
        with patch.object(module, "require_command"), patch.object(module, "run", side_effect=fake_git), patch.object(os, "execv") as reexec:
            if dirty or remote or branch or diverged:
                try:
                    update_repository()
                    raise AssertionError("Unsafe update was accepted")
                except RuntimeError:
                    pass
                assert not any(c[1] == "merge" for c in calls)
                reexec.assert_not_called()
            else:
                update_repository()
                assert ["git", "merge", "--ff-only", "origin/main"] in calls
                assert reexec.call_args.args[1][-1] == "--backend-only"

    with patch.object(module, "ensure_backend_idle"), patch.object(module, "ensure_docker", return_value=True), patch.object(module, "ensure_docker_daemon"), patch.object(module, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")), patch.object(module, "run_or_raise") as commands, patch.object(module, "wait_for_dashboard", side_effect=RuntimeError("health failed")), patch.dict(os.environ):
        try:
            install(SimpleNamespace(backend_only=True, opencode_version=None))
            raise AssertionError("Failed health check was accepted")
        except RuntimeError as error:
            assert str(error) == "health failed"
        assert [call.args[0] for call in commands.call_args_list] == [
            ["docker", "tag", "muse-opencode-bridge:local", "muse-opencode-bridge:rollback"],
            ["docker", "compose", "up", "--build", "-d"],
            ["docker", "tag", "muse-opencode-bridge:rollback", "muse-opencode-bridge:local"],
            ["docker", "compose", "up", "--no-build", "-d"],
        ]

    print("Autoteste do instalador: OK")


def install(args):
    if not sys.platform.startswith("linux"):
        raise RuntimeError("Este instalador foi preparado para Linux/WSL.")
    if args.backend_only:
        ensure_backend_idle()
    if not args.backend_only and not args.opencode_version:
        ensure_opencode()
    if not ensure_docker():
        return False

    version = SimpleNamespace(returncode=0, stdout=args.opencode_version or "", stderr="")
    if not args.backend_only and not args.opencode_version:
        version = run(["opencode", "--version"], capture=True)
    version_text = (version.stdout or version.stderr).strip() if not args.backend_only else "2.0"
    match = re.search(r"\bv?(\d+)\.", version_text)
    if version.returncode != 0 or not match or int(match.group(1)) not in (1, 2):
        raise RuntimeError(f"Não consegui identificar uma versão compatível do OpenCode: {version_text}")
    major = int(match.group(1))
    if run(["docker", "compose", "version"], capture=True).returncode != 0:
        raise RuntimeError("Docker Compose não encontrado. Instale o pacote docker-compose-plugin no WSL.")
    ensure_docker_daemon()

    if run(["docker", "volume", "inspect", VOLUME_NAME], capture=True).returncode != 0:
        if run(["docker", "volume", "create", VOLUME_NAME], capture=True).returncode != 0:
            raise RuntimeError("Não consegui criar o volume persistente do Chromium e da chave local.")

    print("Iniciando o backend Muse no Docker…")
    revision = run(["git", "rev-parse", "HEAD"], capture=True) if shutil.which("git") else None
    clean = run(["git", "status", "--porcelain"], capture=True) if revision and revision.returncode == 0 else None
    os.environ["MUSE_BUILD_REVISION"] = revision.stdout.strip() if clean and clean.returncode == 0 and not clean.stdout.strip() else "unknown"
    rollback = args.backend_only and run(["docker", "image", "inspect", "muse-opencode-bridge:local"], capture=True).returncode == 0
    if rollback:
        run_or_raise(["docker", "tag", "muse-opencode-bridge:local", "muse-opencode-bridge:rollback"], "Não consegui preservar a imagem anterior.")
    try:
        run_or_raise(["docker", "compose", "up", "--build", "-d"], "Docker Compose não conseguiu iniciar o backend.")
        wait_for_dashboard()
    except RuntimeError:
        if rollback:
            run_or_raise(["docker", "tag", "muse-opencode-bridge:rollback", "muse-opencode-bridge:local"], "Falha ao restaurar a imagem anterior.")
            run_or_raise(["docker", "compose", "up", "--no-build", "-d"], "Falha ao reiniciar a imagem anterior.")
            print("Imagem anterior restaurada. O checkout contém o código novo; corrija a falha antes de tentar novamente.")
        raise

    if args.backend_only:
        print("Backend atualizado. Login, conversas e configurações dos clientes foram preservados.")
        return True

    key_name, entry = provider_config(major, read_api_key())
    target = config_path(Path(args.config_dir) if args.config_dir else None)
    changed = update_config(target, key_name, entry)
    print("Backend respondendo em http://127.0.0.1:4317.")
    print(f"OpenCode {'configurado' if changed else 'já estava configurado'} em {target}.")
    print("A chave local foi gravada sem ser exibida e com permissão privada.")
    print("\nPróximos passos:")
    print(f"1. Abra {DASHBOARD_URL} no navegador.")
    print("2. Entre na sua própria conta Muse pelo botão Abrir Chromium e confirme o login.")
    print("3. Reabra o OpenCode e selecione muse/muse-web.")
    print("Não compartilhe o volume Docker nem a chave local; cada computador usa sua própria conta.")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--update", action="store_true", help="Atualiza origin/main e recria o backend preservando o volume")
    parser.add_argument("--backend-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--config-dir", help="Diretório de configuração do cliente Windows, passado pelo PowerShell")
    parser.add_argument("--opencode-version", help="Versão do cliente Windows, passada pelo PowerShell")
    args = parser.parse_args()
    if bool(args.config_dir) != bool(args.opencode_version):
        parser.error("--config-dir e --opencode-version devem ser usados juntos")
    if args.self_test:
        self_test()
        return 0
    try:
        if args.update:
            update_repository()
        if not install(args):
            return 3  # New Docker group: caller must report re-login, never success.
    except (JsoncError, OSError, RuntimeError) as error:
        print(f"Instalação não concluída: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
