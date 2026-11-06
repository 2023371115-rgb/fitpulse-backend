#!/usr/bin/env bash
# FitPulse · instala o actualiza todo el sistema en una instancia AWS EC2 (Ubuntu 24.04 o más reciente).
#
#   curl -fsSL https://raw.githubusercontent.com/2023371115-rgb/fitpulse-backend/main/deploy/aws.sh | sudo bash
#
# Deja en la misma instancia:
#   - MariaDB (compatible con MySQL) con la base "fitpulse_cloud"
#   - API Node.js + Express como servicio systemd (fitpulse-api, puerto 3000 interno)
#   - Web Angular compilada, servida por nginx en el puerto 80
#   - nginx reenvía /api y /uploads a la API
# Se puede volver a correr cuantas veces sea: actualiza el código y conserva datos y contraseñas.
set -euo pipefail

BRANCH="${BRANCH:-main}"
WEB_BRANCH="${WEB_BRANCH:-$BRANCH}"
GH="https://github.com/2023371115-rgb"
APP=/opt/fitpulse
WEB_ROOT=/var/www/fitpulse
SECRETS=/etc/fitpulse/secrets.env
DB_NAME=fitpulse_cloud
DB_USER=fitpulse_app

log() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Ejecuta con sudo"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
# Sin preguntas interactivas: el script llega por "curl | bash" y cualquier pregunta
# leería el resto del script como respuesta.
export NG_CLI_ANALYTICS=false CI=true

log "1/8 Deteniendo la versión anterior (si existe)"
# La primera versión de prueba corría como servicio "fitpulse" en el puerto 80.
systemctl disable --now fitpulse 2>/dev/null || true

log "2/8 Memoria swap de 1 GB (compilar Angular en una t3.micro)"
FREE_MB=$(df -Pm / | awk 'NR==2 {print $4}')
echo "Espacio libre en disco: ${FREE_MB} MB"
[ "$FREE_MB" -ge 1800 ] || { echo "Se necesitan al menos 1.8 GB libres. Amplía el volumen EBS de la instancia."; exit 1; }
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "3/8 Paquetes: Node.js, MariaDB, nginx, git"
apt-get update -qq </dev/null
apt-get install -y -qq nodejs npm mariadb-server nginx git curl >/dev/null </dev/null
systemctl enable --now mariadb nginx >/dev/null
node -v

log "4/8 Credenciales (se generan una sola vez)"
mkdir -p /etc/fitpulse && chmod 700 /etc/fitpulse
if [ ! -f "$SECRETS" ]; then
  cat > "$SECRETS" <<EOV
DB_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 12)
EOV
  chmod 600 "$SECRETS"
fi
# shellcheck disable=SC1090
. "$SECRETS"
mysql -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
          CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
          ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
          GRANT ALL ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;"

log "5/8 Código desde GitHub (rama $BRANCH)"
id fitpulse >/dev/null 2>&1 || useradd -r -m -d "$APP" -s /usr/sbin/nologin fitpulse
mkdir -p "$APP"
fetch() { # repo rama destino
  if [ -d "$3/.git" ]; then
    git -C "$3" fetch -q --depth 1 origin "$2" && git -C "$3" checkout -q -B "$2" FETCH_HEAD
  else
    rm -rf "$3" && git clone -q --depth 1 -b "$2" "$GH/$1.git" "$3"
  fi
}
fetch fitpulse-backend "$BRANCH" "$APP/backend" </dev/null
fetch fitpulse-frontend "$WEB_BRANCH" "$APP/frontend" </dev/null

log "6/8 API (Node.js + Express)"
cd "$APP/backend"
cat > .env <<EOV
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
DB_SSL=false
JWT_SECRET=$JWT_SECRET
SEED_ADMIN_PASSWORD=$ADMIN_PASSWORD
DEPLOY_FRONTEND=AWS EC2 (nginx)
DEPLOY_BACKEND=AWS EC2 (Node.js)
DEPLOY_DATABASE=MariaDB en AWS EC2
EOV
chmod 600 .env
npm ci --omit=dev --no-audit --no-fund --loglevel=error </dev/null
node migrate.js </dev/null
if [ ! -f /etc/fitpulse/.seeded ]; then
  node scripts/seed.js </dev/null && touch /etc/fitpulse/.seeded
fi
mkdir -p uploads
chown -R fitpulse:fitpulse "$APP/backend"
cat > /etc/systemd/system/fitpulse-api.service <<'UNIT'
[Unit]
Description=FitPulse API (Node.js + Express)
After=network.target mariadb.service
Requires=mariadb.service

[Service]
User=fitpulse
WorkingDirectory=/opt/fitpulse/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable fitpulse-api >/dev/null
systemctl restart fitpulse-api

log "7/8 Web (Angular) — compilando, tarda unos minutos"
cd "$APP/frontend"
npm ci --no-audit --no-fund --loglevel=error </dev/null
NODE_OPTIONS=--max-old-space-size=1536 npx ng build --configuration production </dev/null
mkdir -p "$WEB_ROOT"
rm -rf "${WEB_ROOT:?}"/*
cp -r dist/frontend/. "$WEB_ROOT/"
# Libera espacio: las dependencias de compilación ya no hacen falta.
rm -rf node_modules .angular
npm cache clean --force >/dev/null 2>&1 || true

log "8/8 nginx"
cat > /etc/nginx/sites-available/fitpulse <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/fitpulse;
    index index.html;
    client_max_body_size 50m;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;          # Smart TV usa eventos en vivo (SSE)
        proxy_read_timeout 1h;
    }
    location /uploads/ { proxy_pass http://127.0.0.1:3000; }

    location = /index.html { add_header Cache-Control "no-cache"; }
    location / { try_files $uri $uri/ /index.html; }
}
NGINX
ln -sf /etc/nginx/sites-available/fitpulse /etc/nginx/sites-enabled/fitpulse
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

sleep 2
IP=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $(curl -s -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
echo
curl -s http://127.0.0.1/api/health && echo
cat <<DONE

============================================================
 FitPulse quedó listo en AWS
   Web:    http://${IP:-IP-PUBLICA}/
   API:    http://${IP:-IP-PUBLICA}/api/health
   Demo:   ana@correo.com / fitpulse123
   Admin:  admin@fitpulse.com / $ADMIN_PASSWORD
 (las contraseñas están en $SECRETS)
============================================================
DONE
