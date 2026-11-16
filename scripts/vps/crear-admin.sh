#!/usr/bin/env bash
# Crea la cuenta de administrador de plataforma (para la API de altas y, más adelante, los paneles).
#   sudo bash /opt/vincular-ai/scripts/vps/crear-admin.sh
set -euo pipefail
DIR=/opt/vincular-ai
[ "$(id -u)" -eq 0 ] || { echo "Ejecute con sudo." >&2; exit 1; }
read -r -p "Correo del administrador: " EMAIL </dev/tty
read -r -p "Nombre: " NOMBRE </dev/tty
read -r -s -p "Contraseña (mínimo 12 caracteres, no se muestra): " CONTRASENA_NUEVA </dev/tty; echo
[ "${#CONTRASENA_NUEVA}" -ge 12 ] || { echo "La contraseña debe tener al menos 12 caracteres." >&2; exit 1; }
export EMAIL NOMBRE CONTRASENA_NUEVA
sudo -u vincular -H --preserve-env=EMAIL,NOMBRE,CONTRASENA_NUEVA bash -c "cd '$DIR' && set -a && . ./.env && set +a && npm run --silent cli:crear-cuenta -w @vincular/servidor -- --email \"\$EMAIL\" --nombre \"\$NOMBRE\""
