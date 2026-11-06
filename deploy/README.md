# Despliegue en AWS EC2

Todo FitPulse (base de datos, API y web) corre en una sola instancia EC2 con Ubuntu 24.04.

```
Navegador / App Flutter ──► nginx :80 ──┬─► /            web Angular (archivos estáticos)
                                        └─► /api, /uploads ─► API Node.js :3000 ─► MariaDB (MySQL)
```

## Crear la instancia

1. EC2 → **Lanzar instancia** · AMI **Ubuntu Server 24.04 LTS** · tipo `t3.micro`.
2. Red: permitir **SSH** y **HTTP** desde Internet.
3. Lanzar y esperar a que esté *En ejecución*.

## Instalar o actualizar

Conéctate con **Conectar → EC2 Instance Connect** y ejecuta:

```bash
curl -fsSL https://raw.githubusercontent.com/2023371115-rgb/fitpulse-backend/main/deploy/aws.sh | sudo bash
```

Para desplegar otra rama: `... | sudo BRANCH=mi-rama bash`.

El script se puede correr cuantas veces sea: descarga el código nuevo de GitHub, aplica la migración de la base sin borrar datos, recompila la web y reinicia los servicios. Tarda unos 8–10 minutos la primera vez (la compilación de Angular es lo más lento).

Al terminar muestra la dirección de la web y la contraseña del administrador (`admin@fitpulse.com`). Las credenciales se guardan en `/etc/fitpulse/secrets.env`.

## Comandos útiles en el servidor

| Para | Comando |
|---|---|
| Ver si la API está viva | `curl localhost/api/health` |
| Registro de la API | `sudo journalctl -u fitpulse-api -n 50` |
| Reiniciar la API | `sudo systemctl restart fitpulse-api` |
| Entrar a la base | `sudo mysql fitpulse_cloud` |
| Ver los reportes de fallos | `sudo mysql fitpulse_cloud -e "SELECT folio, status, title FROM tickets"` |

La IP pública cambia si detienes y vuelves a iniciar la instancia. Para fijarla asigna una **IP elástica**.
