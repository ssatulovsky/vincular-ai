#!/usr/bin/env bash
# Crea una persona de prueba con su tablet y muestra el código para /tablet.
#   sudo bash /opt/vincular-ai/scripts/vps/alta-prueba.sh
set -euo pipefail
DIR=/opt/vincular-ai
[ "$(id -u)" -eq 0 ] || { echo "Ejecute con sudo." >&2; exit 1; }
read -r -p "Nombre de la persona de prueba (ej. Elena Prueba): " NOMBRE </dev/tty
read -r -p "Comuna (ej. Puerto Montt): " COMUNA </dev/tty
export NOMBRE COMUNA
sudo -u vincular -H --preserve-env=NOMBRE,COMUNA bash -c "cd '$DIR' && set -a && . ./.env && set +a && npm run --silent cli:alta-prueba -w @vincular/servidor -- --nombre \"\$NOMBRE\" --comuna \"\$COMUNA\""
