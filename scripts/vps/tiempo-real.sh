#!/usr/bin/env bash
# Conversación en tiempo real: instala LiveKit (servidor de audio) y el agente de Vincular-IA
# en un VPS donde Vincular-IA ya está instalado (scripts/vps/instalar.sh).
#
#   sudo bash /opt/vincular-ai/scripts/vps/tiempo-real.sh
#
# Qué hace (se puede repetir sin romper nada):
#   1. Descarga LiveKit (servidor libre, sin suscripción) y lo deja como servicio "livekit".
#   2. Publica https://livekit.<su-dominio> con nginx (o Caddy) y su certificado.
#   3. Genera las claves de LiveKit y las escribe en /opt/vincular-ai/.env.
#   4. Deja el agente como servicio "vincular-agente" y reinicia Vincular-IA.
#   5. Abre en ufw los puertos de audio (TCP 7881 y UDP 50000-60000), si ufw está activo.
set -euo pipefail

VERSION_LIVEKIT=1.13.11
DIR=/opt/vincular-ai
USUARIO=vincular
ENV="$DIR/.env"

paso() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
aviso() { printf '\033[1;33m%s\033[0m\n' "$*"; }
error() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || error "Ejecute con sudo."
[ -f "$ENV" ] || error "No encuentro $ENV. Instale primero Vincular-IA con scripts/vps/instalar.sh."

valor() { grep -E "^$1=" "$ENV" | tail -1 | cut -d= -f2- || true; }
fijar() {
  if grep -qE "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else printf '%s=%s\n' "$1" "$2" >> "$ENV"; fi
}

BASE="$(valor BASE_URL_PUBLICA)"
DOMINIO="${BASE#https://}"; DOMINIO="${DOMINIO#http://}"; DOMINIO="${DOMINIO%%/*}"
[ -n "$DOMINIO" ] || error "BASE_URL_PUBLICA está vacía en $ENV."
SUB="livekit.$DOMINIO"
[ -n "$(valor ELEVENLABS_API_KEY)" ] || aviso "Ojo: ELEVENLABS_API_KEY está vacía; el tiempo real usa ElevenLabs para escuchar y hablar."

paso "LiveKit $VERSION_LIVEKIT"
case "$(uname -m)" in
  x86_64) ARQ=amd64 ;;
  aarch64 | arm64) ARQ=arm64 ;;
  *) error "Arquitectura no soportada: $(uname -m)" ;;
esac
if ! /usr/local/bin/livekit-server --version 2>/dev/null | grep -q "$VERSION_LIVEKIT"; then
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/livekit/livekit/releases/download/v${VERSION_LIVEKIT}/livekit_${VERSION_LIVEKIT}_linux_${ARQ}.tar.gz" -o "$TMP/lk.tgz"
  tar -xzf "$TMP/lk.tgz" -C "$TMP" livekit-server
  install -m 0755 "$TMP/livekit-server" /usr/local/bin/livekit-server
  rm -rf "$TMP"
fi
/usr/local/bin/livekit-server --version

paso "Claves y configuración de LiveKit"
CLAVE="$(valor LIVEKIT_API_KEY)"
SECRETO="$(valor LIVEKIT_API_SECRET)"
if [ -z "$CLAVE" ] || [ -z "$SECRETO" ]; then
  CLAVE="API$(openssl rand -hex 6)"
  SECRETO="$(openssl rand -hex 32)"
  echo "Generé claves nuevas."
else
  echo "Uso las claves que ya estaban en $ENV."
fi
mkdir -p /etc/livekit
cat > /etc/livekit/livekit.yaml <<EOF
# Generado por scripts/vps/tiempo-real.sh
port: 7880
# La señalización solo escucha en el propio servidor; afuera se publica por nginx con HTTPS.
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  $CLAVE: $SECRETO
room:
  empty_timeout: 60
logging:
  level: info
EOF
id livekit >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin livekit
chown root:livekit /etc/livekit/livekit.yaml
chmod 640 /etc/livekit/livekit.yaml

fijar LIVEKIT_URL_PUBLICA "wss://$SUB"
fijar LIVEKIT_URL "ws://127.0.0.1:7880"
fijar LIVEKIT_API_KEY "$CLAVE"
fijar LIVEKIT_API_SECRET "$SECRETO"
chown "$USUARIO:$USUARIO" "$ENV"
chmod 600 "$ENV"

cat > /etc/systemd/system/livekit.service <<EOF
[Unit]
Description=LiveKit (audio en tiempo real de Vincular-IA)
After=network-online.target
Wants=network-online.target

[Service]
User=livekit
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit/livekit.yaml
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable livekit >/dev/null
systemctl restart livekit

paso "HTTPS para $SUB"
if command -v nginx >/dev/null && systemctl is-active --quiet nginx; then
  cat > /etc/nginx/sites-available/zz-vincular-livekit <<EOF
# Generado por scripts/vps/tiempo-real.sh
server {
    listen 80;
    server_name $SUB;
    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/zz-vincular-livekit /etc/nginx/sites-enabled/zz-vincular-livekit
  nginx -t
  systemctl reload nginx
  if command -v certbot >/dev/null; then
    certbot --nginx -d "$SUB" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
      || aviso "certbot no pudo emitir el certificado. Revise que $SUB apunte a este servidor y vuelva a ejecutar este script."
  else
    aviso "No encuentro certbot. Instálelo (sudo apt install certbot python3-certbot-nginx) y vuelva a ejecutar este script."
  fi
elif command -v caddy >/dev/null && systemctl is-active --quiet caddy; then
  if ! grep -q "^$SUB" /etc/caddy/Caddyfile; then
    printf '\n%s {\n\treverse_proxy 127.0.0.1:7880\n}\n' "$SUB" >> /etc/caddy/Caddyfile
  fi
  systemctl reload caddy
else
  aviso "No encontré nginx ni Caddy activos. Publique https://$SUB hacia http://127.0.0.1:7880 (con WebSocket)."
fi

paso "Servicio del agente"
cat > /etc/systemd/system/vincular-agente.service <<EOF
[Unit]
Description=Vincular-IA (agente de conversación en tiempo real)
After=network-online.target postgresql.service livekit.service
Wants=network-online.target

[Service]
User=$USUARIO
WorkingDirectory=$DIR
ExecStart=/bin/bash -c 'set -a && . ./.env && set +a && exec /usr/bin/npm run agente -w @vincular/servidor'
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vincular-agente >/dev/null
systemctl restart vincular
systemctl restart vincular-agente

paso "Firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 7881/tcp >/dev/null
  ufw allow 50000:60000/udp >/dev/null
  echo "Abrí en ufw: TCP 7881 y UDP 50000-60000."
else
  echo "ufw no está activo; no cambio nada aquí."
fi

sleep 4
paso "Estado"
for s in livekit vincular vincular-agente; do
  printf '%-16s %s\n' "$s" "$(systemctl is-active "$s")"
done

cat <<EOF

Listo. Faltan dos cosas que no puedo hacer desde aquí:

  1. Si su proveedor del VPS tiene un firewall en su panel web, abra ahí también:
       TCP 7881   y   UDP 50000-60000
  2. En la tablet, recargue https://$DOMINIO/tablet y toque «Conversemos».

Si algo no funciona:
  sudo journalctl -u vincular-agente -n 50 --no-pager
  sudo journalctl -u livekit -n 50 --no-pager
EOF
