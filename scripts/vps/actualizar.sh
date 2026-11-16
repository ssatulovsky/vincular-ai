#!/usr/bin/env bash
# Trae la última versión del código, aplica migraciones nuevas y reinicia el servidor.
#   sudo bash /opt/vincular-ai/scripts/vps/actualizar.sh
set -euo pipefail
DIR=/opt/vincular-ai
[ "$(id -u)" -eq 0 ] || { echo "Ejecute con sudo." >&2; exit 1; }
sudo -u vincular -H bash -c "cd '$DIR' && git pull --ff-only && npm ci --no-audit --no-fund && set -a && . ./.env && set +a && npm run db:migrar"
systemctl restart vincular
sleep 3
systemctl --no-pager --lines=0 status vincular | head -3
echo "Actualizado. Registro: sudo journalctl -u vincular -n 50 --no-pager"
