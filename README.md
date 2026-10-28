# FitPulse Backend

API REST de FitPulse con **Node.js + Express + MySQL**. Es el intermediario entre la app móvil (Flutter), la consola web (Angular), el wearable y la base de datos.

```
App Flutter / Consola web / Wearable  →  API REST (Express)  →  MySQL
```

## Incluye

- Registro e inicio de sesión con JWT y contraseñas cifradas con bcrypt.
- Perfil con peso, estatura, edad y meta diaria de pasos; borrado de cuenta.
- Metas diarias y semanales con **avance calculado en el servidor** a partir de sesiones y lecturas del wearable.
- Registro y consulta de sesiones con distancia, calorías, ritmo cardíaco y su gráfica.
- Resumen de métricas por semana o mes: pasos por día, ritmo en reposo y tiempo por actividad.
- Dispositivos y wearable: vinculación por código, lecturas de sensores, batería y última sincronización.
- Notificaciones automáticas: meta cumplida, sesión guardada, ritmo alto, sincronización y batería baja.
- Panel de administración por rol, Smart TV (SSE) y búsqueda.
- Migración idempotente y compatible con MySQL 8 y con MariaDB/XAMPP.
- 22 pruebas automáticas de la API contra MySQL.

Referencia completa de endpoints: [`docs/api.md`](docs/api.md).

## Requisitos

- Node.js 18 o superior.
- MySQL 8 (o MariaDB/XAMPP). También puedes levantar MySQL con `docker compose up -d`.

## Configuración

```bash
cp .env.example .env      # ajusta DB_USER, DB_PASSWORD y DB_NAME
npm install
npm run migrate           # crea la base y las tablas (seguro de repetir)
npm run seed              # cuenta demo: ana@correo.com / fitpulse123
npm run dev               # http://localhost:3000
```

Al iniciar, el servidor también aplica la migración. En una base creada con versiones anteriores agrega las columnas y tablas nuevas sin borrar datos.

## Scripts

| Comando | Descripción |
|---|---|
| `npm start` | Inicia la API |
| `npm run dev` | Inicia con recarga automática (nodemon) |
| `npm run migrate` | Crea o actualiza el esquema |
| `npm run seed` | Crea o reinicia la cuenta demo con 8 sesiones, 4 metas, un wearable con 14 días de lecturas y notificaciones |
| `npm test` | Pruebas de la API. Usan la base `fitpulse_test`, que se borra y se vuelve a crear |

## Base de datos

| Tabla | Contenido |
|---|---|
| `users` | Cuenta, rol (`user`/`admin`), peso, estatura, edad, meta diaria |
| `devices` | Wearables y teléfonos del usuario, estado, batería, última sincronización |
| `metrics` | Lecturas del wearable: pasos nuevos, ritmo cardíaco, SpO₂ |
| `goals` | Metas: tipo, objetivo, periodo diario/semanal, avance manual |
| `sessions` | Sesiones: tipo, inicio/fin, distancia, pasos, calorías, ritmo promedio/máximo y muestras |
| `notifications` | Avisos para el usuario |
| `files` | Archivos de la consola web |

`users` 1—N `devices` 1—N `metrics` · `users` 1—N `goals`, `sessions`, `notifications`.

## Administradores

El panel `/api/admin` solo acepta usuarios con `role = 'admin'`:

```sql
UPDATE users SET role = 'admin' WHERE email = 'tu-correo@ejemplo.com';
```

Al migrar una base anterior, las cuentas llamadas "superadmin" conservan su acceso.

## Despliegue

- Backend: Render (`https://fitpulse-backend-r77o.onrender.com`).
- Base de datos: Aiven MySQL. Usa `DB_SSL=true` si el servidor exige SSL.
- Salud: `/api/health` · versión: `/api/version`.

Más documentación: `docs/security.md`, `docs/stable-version.md`, `docs/audit-tests.md`.
