# FitPulse · API REST

Base: `http://localhost:3000/api` (local) · `https://fitpulse-backend-r77o.onrender.com/api` (Render)

- Formato: JSON (`Content-Type: application/json`).
- Autenticación: `Authorization: Bearer <token>` (JWT, expira en 12 h). Se obtiene con `/auth/login` o `/auth/register`.
- Zona horaria: los clientes envían `X-Timezone-Offset` en minutos (por ejemplo `-360` para Ciudad de México). Con ese valor se calcula "hoy" y "esta semana" con el día local del usuario. Sin el encabezado se usa UTC.
- Errores: `{ "error": "mensaje" }` con `400` (datos inválidos), `401` (sin sesión o credenciales incorrectas), `403` (sin permiso), `404` (no existe o no es del usuario), `409` (correo repetido) y `500` (mensaje genérico, sin detalles internos).

## Autenticación

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/auth/register` | `name`, `email`, `password` (8–72), opcionales `weight_kg`, `height_cm`, `age`, `daily_step_goal` | `201 { user, token }`. Crea también una meta diaria de pasos y una notificación de bienvenida |
| POST | `/auth/login` | `email`, `password` | `200 { user, token }` · `401 Credenciales incorrectas.` (mismo mensaje si el correo no existe) |

## Perfil

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/profile` | `{ user }` con `name`, `email`, `role`, `weight_kg`, `height_cm`, `age`, `daily_step_goal` |
| PUT | `/profile` | Actualiza `name`, `weight_kg`, `height_cm`, `age`, `daily_step_goal`, `avatar` o la contraseña (`currentPassword`, `newPassword`). Cambiar `daily_step_goal` también actualiza la meta diaria de pasos |
| DELETE | `/profile` | Elimina la cuenta y todos sus datos. Cuerpo: `{ password }` |

## Metas

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/goals` | Metas con su avance calculado: `current`, `progress` (0–1), `done`, `history` (7 periodos) |
| POST | `/goals` | `type`, `target`, `period` (`daily` o `weekly`), `title` opcional |
| PATCH | `/goals/:id` | `active`, `target`, `title` o `manual_value` (avance manual de sueño o peso) |
| DELETE | `/goals/:id` | Elimina la meta |

Tipos y cómo se calcula su avance:

| `type` | Unidad | Avance |
|---|---|---|
| `steps` | pasos | pasos de sesiones + pasos enviados por el wearable |
| `distance` | km | suma de `distance_km` de las sesiones |
| `workouts` | entrenamientos | número de sesiones |
| `calories` | kcal | suma de calorías de las sesiones |
| `active` | min | minutos de las sesiones |
| `sleep`, `weight`, `heart_rate` | horas, kg, bpm | `manual_value` |

## Sesiones

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/sessions?type=running&from=2026-10-01&limit=100` | Historial, de la más reciente a la más antigua |
| GET | `/sessions/:id` | Detalle, incluye `hr_samples` |
| GET | `/sessions/summary` | Totales de los últimos 7 días |
| POST | `/sessions` | Registra una sesión (ver abajo) |
| DELETE | `/sessions/:id` | Elimina la sesión |

Cuerpo de `POST /sessions`:

```json
{
  "type": "running",
  "started_at": "2026-10-27T13:10:00.000Z",
  "duration_sec": 1920,
  "distance_km": 4.8,
  "steps": 5180,
  "calories": 342,
  "avg_heart_rate": 156,
  "max_heart_rate": 176,
  "hr_samples": [120, 138, 150, 162, 176],
  "device_name": "FitPulse Band"
}
```

`type` puede ser `running`, `walking`, `cycling`, `gym`, `swimming` u `other`. En lugar de `duration_sec` se puede enviar `ended_at`.

La respuesta (`201`) incluye `goals_completed`, la lista de metas que se cumplieron con esa sesión. Registrar una sesión genera estas notificaciones:
- "Sesión guardada".
- "¡Meta cumplida!", por cada meta que se cumpla con ella.
- "Ritmo cardíaco alto", si `max_heart_rate` es 175 o más.

## Métricas

`GET /metrics/summary?range=week|month`

```json
{
  "range": "week",
  "today": { "date": "2026-10-27", "steps": 7240, "km": 4.8, "kcal": 342, "active_minutes": 32, "heart_rate": 72 },
  "days": [{ "date": "2026-10-21", "steps": 8120, "km": 3.2, "kcal": 160, "minutes": 38, "sessions": 1 }],
  "totals": { "steps": 63440, "km": 33.6, "kcal": 1868, "minutes": 260, "sessions": 6 },
  "by_type": { "running": { "count": 2, "minutes": 57, "km": 8.5 } },
  "resting_hr": { "current": 62, "delta": -2, "trend": [66, 65, 64] },
  "hr_today": [{ "hour": 6, "bpm": 61 }]
}
```

- **Pasos del día:** pasos de las sesiones más los que envía el wearable.
- **Ritmo en reposo:** el mínimo diario de las lecturas del wearable.
- **`delta`:** compara el promedio de los últimos 7 días con el de los 7 anteriores.

## Dispositivos (wearable)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/devices` | Dispositivos del usuario con `status`, `battery`, `last_sync_at` |
| POST | `/devices` | Registra un dispositivo: `name`, `type` (`wearable`, `phone`, `smarttv`, `other`) |
| PATCH | `/devices/:id/status` | `linked`, `idle` u `offline` |
| DELETE | `/devices/:id` | Desvincula y borra sus lecturas |
| POST | `/devices/:id/metrics/user` | La **app** envía una lectura del wearable con el JWT del usuario: `steps` (pasos nuevos), `heart_rate`, `battery`, `spo2`, `extra`. Genera las notificaciones "Dispositivo sincronizado" y, si la batería es de 20 % o menos, "Batería baja" |
| POST | `/devices/:id/pairing-code` | Genera un código de 6 dígitos (10 min) para vincular un reloj Wear OS |
| POST | `/devices/pair` | El **reloj** canjea el código por su propio token |
| POST | `/devices/:id/metrics` | El **reloj** envía lecturas con su token de dispositivo |
| GET | `/devices/:id/metrics?limit=50` · `/devices/:id/metrics/latest` | Lecturas del dispositivo |

## Notificaciones

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/notifications?limit=50` | `{ unread, items: [{ id, kind, title, body, read, created_at }] }` |
| PATCH | `/notifications/:id/read` | Marca una como leída |
| POST | `/notifications/read-all` | Marca todas como leídas |
| DELETE | `/notifications/:id` | Elimina una |

`kind` puede ser `goal`, `sync`, `heart`, `battery`, `session` o `tip`.

## Administración (consola web)

Las rutas `/admin/*` requieren `role = 'admin'` en la tabla `users`. Ese rol solo se asigna desde la base de datos; ya no basta con llamarse "superadmin".

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/users` | Lista de usuarios |
| PATCH | `/admin/users/:id` | `{ active }` activa o desactiva una cuenta |

## Servicio

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | `{ ok: true, version }` |
| GET | `/version` | Versión de la API |
