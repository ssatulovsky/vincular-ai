#!/usr/bin/env bash
# Instala Vincular-IA en un VPS Ubuntu (22.04 o 24.04) para pruebas y co-diseño acompañado.
#
#   curl -fsSL <url de este archivo> -o instalar.sh
#   sudo bash instalar.sh                          # usa <ip>.sslip.io como dirección
#   sudo bash instalar.sh vincular.ejemplo.cl      # o un subdominio propio que apunte al VPS
#
# Qué hace (se puede volver a correr sin romper nada):
#   1. Instala PostgreSQL 16 + pgvector, Node.js 22, git y Caddy (HTTPS automático).
#   2. Crea el usuario de sistema "vincular" y una llave de despliegue de solo lectura para GitHub.
#   3. Descarga el código en /opt/vincular-ai e instala dependencias.
#   4. Crea la base de datos con sus dos roles y contraseñas aleatorias.
#   5. Genera /opt/vincular-ai/.env con la clave de cifrado. Las claves de API las pone usted.
#   6. Aplica las migraciones y deja el servicio "vincular" listo en systemd, detrás de Caddy.
#
# No es un entorno de producción: no usar con datos de personas reales sin supervisión.
set -euo pipefail

REPO="${VINCULAR_REPO:-ssatulovsky/vincular-ai}"
RAMA="${VINCULAR_RAMA:-main}"
DIR=/opt/vincular-ai
USUARIO=vincular
DOMINIO="${1:-}"

paso() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
aviso() { printf '\033[1;33m%s\033[0m\n' "$*"; }
error() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
como_vincular() { sudo -u "$USUARIO" -H bash -c "$1"; }

[ "$(id -u)" -eq 0 ] || error "Ejecute con sudo: sudo bash instalar.sh"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || error "Este instalador es para Ubuntu (encontré: ${PRETTY_NAME:-desconocido})."
CODENOMBRE="${VERSION_CODENAME}"

paso "Paquetes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg git openssl lsb-release debian-keyring debian-archive-keyring apt-transport-https

paso "Dirección pública"
if [ -z "$DOMINIO" ]; then
  IP="$(curl -fsS4 https://api.ipify.org || true)"
  [ -n "$IP" ] || error "No pude averiguar la IP pública. Ejecute: sudo bash instalar.sh <su-dominio>"
  DOMINIO="${IP//./-}.sslip.io"
fi
echo "https://$DOMINIO"

paso "PostgreSQL 16 y pgvector (repositorio oficial de PostgreSQL)"
if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENOMBRE}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q
fi
apt-get install -y -q postgresql-16 postgresql-16-pgvector
systemctl enable --now postgresql
# Si el VPS ya tenía otra versión de PostgreSQL, la 16 queda en otro puerto: lo detectamos.
PUERTO_PG="$(pg_lsclusters --no-header | awk '$1=="16" && $2=="main" {print $3}')"
[ -n "$PUERTO_PG" ] || error "No encontré el clúster 16/main de PostgreSQL."
pg_ctlcluster 16 main start 2>/dev/null || true

paso "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node --version

paso "Usuario de sistema '$USUARIO'"
id "$USUARIO" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$USUARIO"
HOME_V="$(getent passwd "$USUARIO" | cut -d: -f6)"

paso "Descarga del código desde GitHub"
if [ ! -d "$DIR/.git" ]; then
  como_vincular "mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null"
  [ -f "$HOME_V/.ssh/id_ed25519" ] || como_vincular "ssh-keygen -t ed25519 -N '' -C 'vincular-vps' -f ~/.ssh/id_ed25519 >/dev/null"
  echo
  aviso "Agregue esta llave de despliegue (solo lectura) en GitHub:"
  aviso "  https://github.com/${REPO}/settings/keys  →  Add deploy key"
  aviso "  Title: vps   ·   Key: la línea de abajo   ·   NO marque 'Allow write access'"
  echo
  cat "$HOME_V/.ssh/id_ed25519.pub"
  echo
  read -r -p "Cuando la haya agregado, presione Enter para continuar... " _ </dev/tty
  install -d -o "$USUARIO" -g "$USUARIO" "$DIR"
  como_vincular "git clone --branch '$RAMA' 'git@github.com:${REPO}.git' '$DIR'" || error "No pude descargar el código. ¿Agregó la llave de despliegue en GitHub?"
else
  echo "Ya estaba descargado en $DIR (para actualizar use scripts/vps/actualizar.sh)."
fi

paso "Dependencias"
como_vincular "cd '$DIR' && npm ci --no-audit --no-fund"

paso "Base de datos"
EXISTE_ROL="$(sudo -u postgres psql -p "$PUERTO_PG" -tAc "SELECT 1 FROM pg_roles WHERE rolname='vincular_app'")"
if [ "$EXISTE_ROL" != "1" ]; then
  CLAVE_OWNER="$(openssl rand -hex 24)"
  CLAVE_APP="$(openssl rand -hex 24)"
  sudo -u postgres psql -p "$PUERTO_PG" -v ON_ERROR_STOP=1 -v owner_pass="$CLAVE_OWNER" -v app_pass="$CLAVE_APP" -v db=vincular -f "$DIR/apps/servidor/db/bootstrap.sql" >/dev/null
  NUEVA_BD=1
else
  echo "La base de datos ya existía; no cambio sus contraseñas."
  NUEVA_BD=0
fi

paso "Archivo de configuración (.env)"
ENV="$DIR/.env"
if [ ! -f "$ENV" ]; then
  [ "$NUEVA_BD" = "1" ] || error "La base existe pero falta $ENV: no puedo recuperar sus contraseñas. Restaure el .env o borre la base y los roles."
  cp "$DIR/.env.example" "$ENV"
  fijar() { sed -i "s|^$1=.*|$1=$2|" "$ENV"; }
  fijar NODE_ENV development
  fijar HOST 127.0.0.1
  fijar PUERTO 3000
  fijar DATABASE_URL "postgres://vincular_app:${CLAVE_APP}@localhost:${PUERTO_PG}/vincular"
  fijar DATABASE_URL_MIGRACIONES "postgres://vincular_owner:${CLAVE_OWNER}@localhost:${PUERTO_PG}/vincular"
  fijar CLAVE_CIFRADO "$(openssl rand -hex 32)"
  fijar BASE_URL_PUBLICA "https://$DOMINIO"
  chown "$USUARIO:$USUARIO" "$ENV"
  chmod 600 "$ENV"
  echo "Creado $ENV (solo lo puede leer el usuario $USUARIO)."
else
  echo "$ENV ya existía; no lo toco."
fi

paso "Migraciones"
como_vincular "cd '$DIR' && set -a && . ./.env && set +a && npm run db:migrar"

paso "Servicio systemd"
cat > /etc/systemd/system/vincular.service <<EOF
[Unit]
Description=Vincular-IA (servidor)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=$USUARIO
WorkingDirectory=$DIR
ExecStart=/bin/bash -c 'set -a && . ./.env && set +a && exec /usr/bin/npm run start -w @vincular/servidor'
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vincular >/dev/null

paso "HTTPS con Caddy"
OCUPADO="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v caddy || true)"
if [ -n "$OCUPADO" ]; then
  aviso "Los puertos 80/443 ya los usa otro programa (¿nginx o apache?). No instalo Caddy."
  aviso "Configure ese programa para enviar https://$DOMINIO a http://127.0.0.1:3000 (con WebSocket)."
else
  if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
  fi
  cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl enable caddy >/dev/null
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    echo "Abrí los puertos 80 y 443 en el firewall (ufw)."
  fi
fi

paso "Listo"
cat <<EOF

Vincular-IA quedó instalado en $DIR. Faltan sus claves (nunca las pegue en un chat):

  1. Edite la configuración:      sudo -u $USUARIO nano $DIR/.env
     Complete GEMINI_API_KEY o ANTHROPIC_API_KEY, los modelos IA_MODELO_* y, para la voz,
     ELEVENLABS_API_KEY. Guarde con Ctrl+O, Enter y salga con Ctrl+X.
  2. Encienda el servidor:        sudo systemctl restart vincular
  3. Revise que esté bien:        sudo journalctl -u vincular -n 50 --no-pager
  4. Cree una persona de prueba:  sudo bash $DIR/scripts/vps/alta-prueba.sh
  5. En la tablet abra:           https://$DOMINIO/tablet   y pegue el código que le dio el paso 4.

EOF
