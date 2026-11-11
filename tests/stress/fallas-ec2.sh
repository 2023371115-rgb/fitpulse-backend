#!/usr/bin/env bash
# Práctica 12 · Fallos controlados en el servidor para las pruebas de resiliencia (RES-01…RES-08).
#
#   sudo bash fallas-ec2.sh api-caida   30   # RES-04/06: detiene la API → nginx responde 502; se reinicia sola
#   sudo bash fallas-ec2.sh bd-caida    30   # RES-04/06: detiene MariaDB → la API responde 500; se reinicia sola
#   sudo bash fallas-ec2.sh sin-respuesta 40 # RES-03: descarta los paquetes al puerto 80 → la app espera hasta su timeout
#   sudo bash fallas-ec2.sh pausa       25   # RES-07/08: congela la API (SIGSTOP); las solicitudes se procesan TARDE,
#                                            #   después del timeout de 15 s de la app (el servidor guarda, la respuesta no llega)
#   sudo bash fallas-ec2.sh respuesta-perdida 40  # RES-07/08: el servidor recibe y GUARDA, pero sus respuestas
#                                            #   (puerto 80 de salida) se descartan: la app no se entera y reintenta
#   sudo bash fallas-ec2.sh estado           # muestra cómo está todo y deshace cualquier fallo que haya quedado
#
# Cada fallo se revierte solo al terminar el tiempo, con Ctrl+C o si la terminal se cierra (trap).
# Imprime la hora exacta (UTC, con milisegundos) de inicio y fin para compararla con la app.
# Solo toca el puerto 80: la sesión SSH (puerto 22) no se ve afectada.
set -u
MODE="${1:-estado}"
SECS="${2:-30}"
ts() { date -u '+%H:%M:%S.%3N UTC'; }
NODE_PID() { systemctl show -p MainPID --value fitpulse-api; }
RULE=(INPUT -p tcp --dport 80 -m comment --comment fitpulse-p12 -j DROP)
RULE_OUT=(OUTPUT -p tcp --sport 80 -m comment --comment fitpulse-p12-out -j DROP)

revert() {
  case "$MODE" in
    api-caida) systemctl start fitpulse-api ;;
    bd-caida) systemctl start mariadb ;;   # sin reiniciar la API: se prueba que el pool se reconecte solo
    sin-respuesta) while iptables -C "${RULE[@]}" 2>/dev/null; do iptables -D "${RULE[@]}"; done ;;
    pausa) kill -CONT "$(NODE_PID)" 2>/dev/null ;;
    respuesta-perdida) while iptables -C "${RULE_OUT[@]}" 2>/dev/null; do iptables -D "${RULE_OUT[@]}"; done ;;
  esac
  echo "$(ts)  FIN del fallo '$MODE' · servicio restablecido"
  check
  for i in $(seq 1 20); do c=$(dbprobe); [ "$c" = 200 ] && break; sleep 0.5; done
  echo "$(ts)  consulta a la BD (GET /api/sessions) → $c (200 = la BD responde; intento $i)"
}

check() {
  local t0 code
  for i in $(seq 1 20); do
    t0=$(date +%s%N)
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1/api/health)
    if [ "$code" = 200 ]; then echo "$(ts)  /api/health → 200 en $(( ($(date +%s%N) - t0) / 1000000 )) ms (intento $i)"; return; fi
    sleep 0.5
  done
  echo "$(ts)  /api/health sigue respondiendo $code — revisa: sudo journalctl -u fitpulse-api -n 30"
}

# Un endpoint que sí consulta la base: GET /api/sessions con un token firmado para un usuario inexistente
# → 200 si la BD responde, 500 si no. (No usa /api/auth para no gastar el límite de intentos de login.)
APP_DIR="${APP_DIR:-/opt/fitpulse/backend}"
PROBE_TOKEN=$(cd "$APP_DIR" 2>/dev/null && node -e "require('dotenv').config();process.stdout.write(require('jsonwebtoken').sign({sub:'sonda-p12-inexistente',email:'sonda-p12'},process.env.JWT_SECRET||'dev_secret_change_me',{expiresIn:'2h'}))" 2>/dev/null)
dbprobe() {
  curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Authorization: Bearer $PROBE_TOKEN" 'http://127.0.0.1/api/sessions?limit=1'
}

countdown() {
  for ((s = SECS; s > 0; s--)); do printf '\r  quedan %3d s ' "$s"; sleep 1; done; printf '\r%20s\r' ''
}

case "$MODE" in
  api-caida|bd-caida|sin-respuesta|pausa|respuesta-perdida) ;;
  estado)
    iptables -C "${RULE[@]}" 2>/dev/null && { iptables -D "${RULE[@]}"; echo "Quité una regla DROP pendiente del puerto 80"; }
    iptables -C "${RULE_OUT[@]}" 2>/dev/null && { iptables -D "${RULE_OUT[@]}"; echo "Quité una regla DROP pendiente de salida del puerto 80"; }
    kill -CONT "$(NODE_PID)" 2>/dev/null
    systemctl is-active --quiet mariadb || systemctl start mariadb
    systemctl is-active --quiet fitpulse-api || systemctl start fitpulse-api
    echo "API: $(systemctl is-active fitpulse-api) · MariaDB: $(systemctl is-active mariadb) · nginx: $(systemctl is-active nginx)"
    check; exit 0 ;;
  *) sed -n 2,15p "$0"; exit 1 ;;
esac

[ "$(id -u)" = 0 ] || { echo "Ejecuta con sudo"; exit 1; }
trap revert EXIT
trap 'exit 130' INT TERM HUP
echo "Servidor sano antes del fallo:"; check; echo "  consulta a la BD (GET /api/sessions) → $(dbprobe)"
echo "$(ts)  INICIO del fallo '$MODE' durante ${SECS} s"
case "$MODE" in
  api-caida) systemctl stop fitpulse-api; echo "  La API está detenida: nginx responde 502 Bad Gateway" ;;
  bd-caida) systemctl stop mariadb; echo "  MariaDB está detenida: la API responde 500" ;;
  sin-respuesta) iptables -I "${RULE[@]}"; echo "  El puerto 80 descarta todo: las solicitudes quedan sin respuesta" ;;
  pausa) kill -STOP "$(NODE_PID)"; echo "  La API está congelada: recibe las solicitudes pero las procesará hasta el final" ;;
  respuesta-perdida) iptables -I "${RULE_OUT[@]}"; echo "  Las solicitudes llegan y se procesan, pero ninguna respuesta sale del servidor" ;;
esac
code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1/api/health); echo "  /api/health ahora → ${code/000/sin respuesta (3 s)}"
[ "$MODE" = bd-caida ] && echo "  consulta a la BD ahora → $(dbprobe) (la API sigue viva, pero falla todo lo que usa la BD)"
countdown
