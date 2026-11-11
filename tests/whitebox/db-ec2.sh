#!/usr/bin/env bash
# Práctica 11 · Pruebas white box de la base de datos en el servidor (EC2).
#
#   curl -fsSL <url-del-script> | sudo bash              # pruebas de BD
#   curl -fsSL <url-del-script> | sudo bash -s monitor  # CPU y memoria durante 90 s (correr mientras la laptop hace la carga)
#
# Usa un usuario temporal (wb-db-...) y lo borra al terminar: no modifica datos reales.
# Guarda la salida en /tmp/fitpulse-whitebox-db.txt
set -uo pipefail
DB="${DB_NAME:-fitpulse_cloud}"
OUT=/tmp/fitpulse-whitebox-db.txt
M() { mariadb --batch --skip-column-names "$DB" -e "$1" 2>&1; }
MT() { mariadb --table "$DB" -e "$1" 2>&1; }

if [ "${1:-}" = "monitor" ]; then
  SECS="${2:-90}"
  echo "Midiendo CPU y memoria cada segundo durante ${SECS} s. Inicia ahora la prueba de carga en la laptop."
  : > /tmp/wb-mon.txt
  for i in $(seq 1 "$SECS"); do
    ps -C node,mariadbd,mysqld -o comm=,%cpu=,rss= | awk -v t="$i" '{print t, $1, $2, $3}' >> /tmp/wb-mon.txt
    sleep 1
  done
  echo "== CPU y memoria (${SECS} muestras) =="
  awk '{c[$2]+=$3; n[$2]++; if($3>mc[$2])mc[$2]=$3; m[$2]+=$4; if($4>mm[$2])mm[$2]=$4}
       END{for(k in c) printf "%-9s CPU prom %.1f%%  máx %.1f%% · RAM prom %.0f MB  máx %.0f MB\n", k, c[k]/n[k], mc[k], m[k]/n[k]/1024, mm[k]/1024}' /tmp/wb-mon.txt
  free -m | awk 'NR==2{printf "Memoria del servidor: %s MB usados de %s MB\n",$3,$2}'
  exit 0
fi

exec > >(tee "$OUT") 2>&1
echo "FitPulse · Práctica 11 · Base de datos ($DB) · $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "Servidor: $(. /etc/os-release; echo "$PRETTY_NAME") · kernel $(uname -r) · $(nproc) vCPU · $(free -m | awk 'NR==2{print $2}') MB RAM"
echo "MariaDB: $(mariadb --version | sed 's/.*Distrib //; s/,.*//') · Node $(node -v 2>/dev/null) · backend $(git -C /opt/fitpulse/backend log -1 --format='%h %ad' --date=short 2>/dev/null)"
echo "Registros: $(M "SELECT CONCAT('usuarios ',(SELECT COUNT(*) FROM users),' · sesiones ',(SELECT COUNT(*) FROM sessions),' · metas ',(SELECT COUNT(*) FROM goals),' · notificaciones ',(SELECT COUNT(*) FROM notifications),' · tickets ',(SELECT COUNT(*) FROM tickets))")"
echo

echo "== Restricciones e índices =="
M "SELECT CONCAT(TABLE_NAME,'.',COLUMN_NAME,' → ',REFERENCED_TABLE_NAME,'.',REFERENCED_COLUMN_NAME) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='$DB' AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY 1" | sed 's/^/  FK  /'
M "SELECT CONCAT(TABLE_NAME,'.',INDEX_NAME,' (',GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX),')',IF(NON_UNIQUE=0,' UNIQUE','')) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME IN ('users','sessions','goals','tickets','notifications') GROUP BY TABLE_NAME,INDEX_NAME,NON_UNIQUE ORDER BY 1" | sed 's/^/  IDX /'
echo "  sql_mode: $(M 'SELECT @@sql_mode')"
echo

U="wb-db-$(date +%s)"
U2="${U}-b"
G="wbg-$(date +%s)"
M "INSERT INTO users(id,email,password_hash,name) VALUES('$U','$U@fitpulse.test','x','Prueba BD'),('$U2','$U2@fitpulse.test','x','Prueba BD 2')" >/dev/null
run() { # id, descripción, SQL
  local t0 t1 r
  t0=$(date +%s%N); r=$(M "$3"); t1=$(date +%s%N)
  case "$r" in *ERROR*) r="RECHAZADO: $(echo "$r" | grep -o 'ERROR.*' | head -1)";; esac
  printf "%-6s %-58s %6.1f ms  %s\n" "$1" "$2" "$(echo "($t1-$t0)/1000000" | bc -l)" "$(echo "$r" | tr '\n' ' ' | cut -c1-110)"
}
echo "== Operaciones CRUD (tabla goals, usuario temporal $U) · el tiempo incluye abrir el cliente mariadb =="
run DB-01 "Inserción válida" "INSERT INTO goals(id,user_id,type,title,target,unit,period) VALUES('$G','$U','steps','Meta de prueba',8000,'pasos','daily'); SELECT ROW_COUNT();"
run DB-02a "Inserción sin user_id (NOT NULL)" "INSERT INTO goals(id,type,target) VALUES('${G}x','steps',100)"
run DB-02b "Inserción con usuario inexistente (FK)" "INSERT INTO goals(id,user_id,type,target) VALUES('${G}y','no-existe','steps',100)"
run DB-02c "Inserción con periodo no permitido (ENUM)" "INSERT INTO goals(id,user_id,type,target,period) VALUES('${G}z','$U','steps',100,'monthly')"
run DB-02d "Inserción con id repetido (PRIMARY KEY)" "INSERT INTO goals(id,user_id,type,target) VALUES('$G','$U','steps',100)"
run DB-02e "Usuario con correo repetido (UNIQUE)" "INSERT INTO users(id,email,password_hash) VALUES('${U}-c','$U@fitpulse.test','x')"
run DB-03a "Consulta por id existente" "SELECT CONCAT(id,' · ',title,' · ',target) FROM goals WHERE id='$G'"
run DB-03b "Consulta por id inexistente" "SELECT COUNT(*) FROM goals WHERE id='no-existe'"
run DB-04 "Actualización (target 8000 → 9500)" "UPDATE goals SET target=9500 WHERE id='$G' AND user_id='$U'; SELECT ROW_COUNT();"
run DB-04b "Consulta después de actualizar" "SELECT target FROM goals WHERE id='$G'"
run DB-04c "Actualización con user_id de otro usuario" "UPDATE goals SET target=1 WHERE id='$G' AND user_id='$U2'; SELECT ROW_COUNT();"
run DB-07 "Transacción con error y ROLLBACK" "START TRANSACTION; INSERT INTO goals(id,user_id,type,target) VALUES('${G}t','$U','steps',100); ROLLBACK; SELECT COUNT(*) FROM goals WHERE id='${G}t';"
echo

echo "== Concurrencia sobre el mismo registro =="
# A bloquea la fila 3 s con SELECT ... FOR UPDATE; B intenta actualizarla al mismo tiempo.
( M "START TRANSACTION; SELECT target FROM goals WHERE id='$G' FOR UPDATE; DO SLEEP(3); UPDATE goals SET target=10000 WHERE id='$G'; COMMIT;" >/dev/null ) & PA=$!
sleep 0.5
t0=$(date +%s%N); M "UPDATE goals SET target=11000 WHERE id='$G'" >/dev/null; t1=$(date +%s%N)
wait $PA
printf "DB-06a B esperó %.0f ms a que A liberara el bloqueo · valor final %s (gana la última escritura)\n" "$(echo "($t1-$t0)/1000000" | bc -l)" "$(M "SELECT target FROM goals WHERE id='$G'")"
# Actualización perdida: dos clientes leen el mismo valor y suman 1 sin bloquear
M "UPDATE goals SET manual_value=0 WHERE id='$G'" >/dev/null
for k in 1 2; do ( v=$(M "SELECT manual_value FROM goals WHERE id='$G'"); sleep 0.3; M "UPDATE goals SET manual_value=$v+1 WHERE id='$G'" >/dev/null ) & PIDS="${PIDS:-} $!"; done; wait $PIDS; PIDS=
printf "DB-06b Leer y luego sumar 1 desde 2 clientes sin bloqueo: valor final %s (esperado 2)\n" "$(M "SELECT manual_value FROM goals WHERE id='$G'" | sed 's/\.00//')"
M "UPDATE goals SET manual_value=0 WHERE id='$G'" >/dev/null
for k in 1 2; do ( M "UPDATE goals SET manual_value=manual_value+1 WHERE id='$G'" >/dev/null ) & PIDS="${PIDS:-} $!"; done; wait $PIDS; PIDS=
printf "DB-06c Suma atómica (manual_value = manual_value + 1) desde 2 clientes: valor final %s\n" "$(M "SELECT manual_value FROM goals WHERE id='$G'" | sed 's/\.00//')"
echo

run DB-05 "Eliminación" "DELETE FROM goals WHERE id='$G'; SELECT ROW_COUNT();"
run DB-05b "Consulta después de eliminar" "SELECT COUNT(*) FROM goals WHERE id='$G'"
echo

echo "== Tiempo y plan de ejecución de consultas de la API (3 ejecuciones cada una) =="
UA=$(M "SELECT user_id FROM sessions GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1")
[ -z "$UA" ] && UA="$U"
q() { # id, descripción, SQL
  local times="" plan
  for k in 1 2 3; do
    times="$times $(M "ANALYZE FORMAT=JSON $3" | grep -o '"r_total_time_ms": [0-9.]*' | head -1 | awk '{printf "%.3f", $2}')"
  done
  plan=$(mariadb --batch "$DB" -e "EXPLAIN $3" 2>&1 | awk -F'\t' 'NR>1{printf "%s: type=%s key=%s rows=%s extra=%s; ", $3, $4, $6, $9, $10}')
  echo "$1 $2"
  echo "    tiempo en el servidor (ms):$times"
  echo "    plan: $plan"
}
q Q1 "GET /api/sessions (lista de un usuario)" "SELECT id,type,started_at,distance_km,calories FROM sessions WHERE user_id='$UA' ORDER BY started_at DESC LIMIT 100"
q Q2 "GET /api/goals (metas de un usuario)" "SELECT id,type,title,target FROM goals WHERE user_id='$UA' ORDER BY created_at ASC"
q Q3 "GET /api/admin/tickets (orden por estado y gravedad)" "SELECT t.id,t.title,u.email FROM tickets t LEFT JOIN users u ON u.id=t.user_id ORDER BY FIELD(t.status,'open','in_progress','resolved','closed'), FIELD(t.severity,'critical','high','medium','low'), t.created_at DESC LIMIT 500"
q Q4 "Notificaciones de un usuario (más recientes)" "SELECT id,title FROM notifications WHERE user_id='$UA' ORDER BY created_at DESC LIMIT 50"
q Q5 "Login (búsqueda por correo)" "SELECT id,password_hash FROM users WHERE email='ana@correo.com'"
echo

M "DELETE FROM users WHERE id LIKE 'wb-db-%'" >/dev/null
echo "Limpieza: usuario temporal eliminado (ON DELETE CASCADE borra sus metas). Restantes: $(M "SELECT COUNT(*) FROM users WHERE id LIKE 'wb-db-%'")"
echo "Salida guardada en $OUT"
