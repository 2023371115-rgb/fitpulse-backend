# Pruebas auditables de falla y recuperacion

Este documento sirve como evidencia para la rubrica de "pruebas auditables en caso de falla".

## FA-01 Backend sin base de datos

Accion:

1. Desplegar backend sin variables `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
2. Revisar logs de Render.

Falla esperada:

```text
connect ECONNREFUSED 127.0.0.1:3306
```

Correccion aplicada:

- Crear base MySQL en Aiven.
- Configurar variables `DB_*` en Render.
- Ejecutar redeploy.

Evidencia de recuperacion esperada:

```text
Retention cleanup complete { metricsDeleted: 0, sessionsDeleted: 0 }
Your service is live
```

## FA-02 Tablas faltantes en Aiven

Accion:

1. Conectar DBeaver a Aiven.
2. Ejecutar `SHOW TABLES;`.

Falla observada:

```text
Table 'defaultdb.metrics' doesn't exist
Table 'defaultdb.sessions' doesn't exist
```

Correccion aplicada:

- Ejecutar `sql/init.sql`.
- Crear tablas `users`, `files`, `devices`, `metrics`, `goals`, `sessions`.

Comprobacion:

```sql
SHOW TABLES;
```

Resultado esperado:

```text
devices
files
goals
metrics
sessions
users
```

## FA-03 Perfil sin columna avatar

Accion:

1. Abrir "Mi perfil".
2. Revisar error de API.

Falla esperada:

```text
GET /api/profile -> 500
```

Correccion aplicada:

- Agregar `avatar MEDIUMTEXT NULL` al esquema.
- Agregar verificacion automatica en `routes/profile.js`.

Comprobacion:

```powershell
curl.exe https://fitpulse-backend-r77o.onrender.com/api/health
```

Resultado esperado:

```json
{"ok":true}
```

## FA-04 Frontend apuntando a localhost

Falla:

En celular el registro fallaba porque el build usaba `environment.ts` con:

```text
http://localhost:3000/api
```

Correccion aplicada:

- `ng build --configuration production`.
- `fileReplacements` de `environment.ts` por `environment.prod.ts`.
- `environment.prod.ts` apunta a Render.

Comprobacion:

1. Vercel deploy en estado `Ready`.
2. Registro desde navegador movil.
3. Usuario creado en Aiven.

## FA-05 Smart TV sin sesion compartida

Falla:

Abrir `?tv=1` en otro navegador podia no tener token local.

Correccion aplicada:

- El boton "Modo TV" abre URL con token temporal.
- El frontend guarda el token y limpia la URL.

Comprobacion:

1. Iniciar sesion en telefono/web.
2. Abrir "Modo TV".
3. La TV muestra `En vivo SSE`.
4. Buscar o seleccionar tarjetas desde telefono.
5. La TV recibe la actualizacion.
