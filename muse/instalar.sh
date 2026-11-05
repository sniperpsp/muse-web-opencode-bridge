#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v apt-get >/dev/null; then
  echo 'A instalação automática suporta Ubuntu ou Debian no WSL 2.' >&2
  exit 1
fi
missing=()
for tool in python3 git curl unzip; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
  sudo apt-get update
  sudo apt-get install -y "${missing[@]}" ca-certificates
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "Use Python 3.10+ (Ubuntu 22.04+ ou Debian 12+).")'
exec python3 instalar-opencode.py "$@"
