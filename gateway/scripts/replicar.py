#!/usr/bin/env python3
"""Cria uma réplica de uma ponte (mesma imagem, volume clonado, logada igual).

Uso:  python3 replicar.py <ponte> <porta-api> <porta-vnc> <numero>
Ex.:  python3 replicar.py deepseek 4437 4438 2   -> container deepseek-opencode-bridge-2

- Clona o volume /data da ponte original (login, chave da API); remove conversations.json e os Singleton* do Chromium.
- A original é parada por alguns segundos durante a cópia (para o perfil sair consistente) e religada.
- Rodando de novo com o volume da réplica já existente, só recria o container (útil depois de reconstruir a imagem).
- Limite de 1,5 GB de memória e 1 GB de /dev/shm por réplica. O ChatGPT usa 1,3–1,8 GB: com pouca RAM, não passe de 2 instâncias.
Depois, registre a réplica em BACKENDS com "group": "<ponte>" (ver gateway/README.md e scripts/gt-gateway).
"""
import json, subprocess, sys


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True)


if len(sys.argv) != 5:
    sys.exit(__doc__)
name, api, vnc, n = sys.argv[1:5]
src = f"{name}-opencode-bridge"
dst = f"{src}-{n}"
info = json.loads(sh("docker", "inspect", src).stdout)[0]
image = info["Config"]["Image"]
env = [e for e in info["Config"]["Env"] if e.startswith("MUSE_") and not e.startswith("MUSE_VNC_URL=")]
vol = [m["Name"] for m in info["Mounts"] if m["Destination"] == "/data"][0]
newvol = f"{vol}-{n}"
exists = sh("docker", "volume", "inspect", newvol).returncode == 0
was_running = info["State"]["Running"] and not exists

if was_running:
    print("parando", src)
    sh("docker", "stop", src)
sh("docker", "rm", "-f", dst)
if not exists:
    sh("docker", "volume", "create", newvol)
    r = sh("docker", "run", "--rm", "-v", f"{vol}:/from", "-v", f"{newvol}:/to", "--user", "root", "--entrypoint", "sh", image, "-c",
           "cp -a /from/. /to/ && rm -f /to/conversations.json /to/chromium-profile/Singleton* && chown -R node:node /to")
    print("clone:", r.returncode, r.stderr[:200])
if was_running:
    sh("docker", "start", src)
    print("religado", src)
cmd = ["docker", "run", "-d", "--name", dst, "--init", "--restart", "unless-stopped", "--shm-size", "1gb", "--memory", "1500m",
       "-p", f"127.0.0.1:{api}:4317", "-p", f"127.0.0.1:{vnc}:7900", "-v", f"{newvol}:/data"]
for e in env:
    cmd += ["-e", e]
cmd += ["-e", f"MUSE_VNC_URL=http://127.0.0.1:{vnc}/vnc.html?autoconnect=1&resize=scale&host=127.0.0.1&port={vnc}&path=websockify", image]
r = sh(*cmd)
print("run:", r.returncode, r.stdout[:12], r.stderr[:200])
