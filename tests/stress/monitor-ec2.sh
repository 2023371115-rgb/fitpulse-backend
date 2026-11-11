#!/usr/bin/env bash
# Práctica 12 · CPU y memoria del servidor durante la prueba de estrés.
#
#   curl -fsSL <url> | sudo bash -s 240     # mide 240 s (inicia estres.js en la laptop justo después)
#
# Usa top en modo batch (1 muestra por segundo): %CPU instantáneo y memoria residente (RES)
# de node (API) y mariadbd, más el CPU total, el robo de CPU (st) y la memoria del sistema.
# Guarda la serie en /tmp/fitpulse-monitor.csv e imprime el resumen.
SECS="${1:-180}"
CSV=/tmp/fitpulse-monitor.csv
NODE=$(pgrep -d, -f "node .*server.js")
DB=$(pgrep -d, -x mariadbd || pgrep -d, -x mysqld)
[ -z "$NODE" ] && { echo "No encontré el proceso de la API (node server.js)"; exit 1; }
echo "Midiendo ${SECS} s · API pid ${NODE} · MariaDB pid ${DB} · $(nproc) vCPU · $(date -u '+%H:%M:%S UTC')"
echo "Inicia ahora la prueba de estrés en la laptop."
echo "t,proceso,cpu_pct,res_mb,sistema_cpu_pct,steal_pct,mem_usada_mb" > "$CSV"
top -b -d 1 -n "$SECS" -e m -E m -p "${NODE},${DB}" | awk -v csv="$CSV" '
  /^top -/ { t++ }
  /^%Cpu/ { gsub(",", " "); for (i = 1; i <= NF; i++) { if ($(i+1) == "id") idle = $i; if ($(i+1) == "st") st = $i }; sys = 100 - idle }
  /MiB Mem/ { for (i = 1; i <= NF; i++) if ($(i+1) ~ /^used/) used = $i }
  /^ *[0-9]+ / { cmd = $12; res = $6; sub(/m$/, "", res); if (res ~ /g$/) { sub(/g$/, "", res); res = res * 1024 }
                 printf "%d,%s,%s,%s,%.1f,%s,%s\n", t, cmd, $9, res, sys, st, used >> csv }'
echo "Fin: $(date -u '+%H:%M:%S UTC') · serie guardada en $CSV"
awk -F, 'NR > 1 {
    p = $2; c[p] += $3; n[p]++; if ($3 > mc[p]) mc[p] = $3; if (!(p in r0)) r0[p] = $4; if ($4 > mr[p]) mr[p] = $4; rf[p] = $4
    if (!($1 in seen)) { seen[$1] = 1; s += $5; ns++; if ($5 > ms) ms = $5; st += $6; if ($7 > mu) mu = $7; if ($5 >= 90) sat++ }
  }
  END {
    for (p in c) printf "%-9s CPU prom %5.1f %%  máx %5.1f %%  · RAM inicial %4.0f MB  máx %4.0f MB  final %4.0f MB\n", p, c[p]/n[p], mc[p], r0[p], mr[p], rf[p]
    printf "Sistema   CPU prom %5.1f %%  máx %5.1f %%  · segundos con CPU ≥ 90 %%: %d de %d · robo (st) prom %.1f %% · memoria usada máx %.0f MB\n", s/ns, ms, sat, ns, st/ns, mu
  }' "$CSV"
