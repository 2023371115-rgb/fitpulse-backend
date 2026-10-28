# FitPulse - Seguridad y privacidad

## OWASP Mobile Top 10 2024

1. Improper credential usage: no se deben guardar JWT ni API keys en codigo; Flutter recibe `FITPULSE_TOKEN` por `--dart-define`.
2. Inadequate supply chain security: dependencias se instalan con lockfiles y CI ejecuta build.
3. Insecure authentication/authorization: backend valida JWT en rutas de usuario y token de dispositivo en metricas.
4. Insufficient input/output validation: API usa consultas parametrizadas y valida tipos principales.
5. Insecure communication: para demo local se usa HTTP; en despliegue debe usarse HTTPS para PWA y SSE.
6. Inadequate privacy controls: se documentan los datos de salud, su retencion (lecturas 30 dias, sesiones 365 dias) y el borrado de cuenta desde la app.
7. Insufficient binary protections: APK de demo no debe publicarse con secretos embebidos.
8. Security misconfiguration: se agrega CSP en `index.html` y `.gitignore` bloquea `.env`, `.jks` y `.keystore`.
9. Insecure data storage: localStorage solo guarda cache de TV con timestamp y se borra despues de 30 dias.
10. Insufficient cryptography: contrasenas se guardan con bcrypt; tokens se firman con `JWT_SECRET`.

## Comunicacion TV

La sincronizacion telefono-TV usa Server-Sent Events en `/api/tv/events`. El canal requiere JWT en query string porque `EventSource` no permite headers personalizados. En produccion debe ejecutarse solo sobre HTTPS.

No se usa `BroadcastChannel` para datos sensibles. Si se agrega para comunicacion entre pestanas, todo mensaje debe incluir `type`, `createdAt` y `sourceOrigin`, y el receptor debe rechazar mensajes cuyo `sourceOrigin !== window.location.origin`.

## LFPDPPP

Datos personales manejados:

- Correo electronico y nombre de usuario.
- Datos de salud/actividad: pasos, ritmo cardiaco, SpO2, temperatura, sesiones y metas.
- Identificadores de dispositivos registrados.

Finalidad:

- Mostrar seguimiento de actividad fisica en telefono, wearable y Smart TV.
- Sincronizar metricas durante la demo academica.

Base legal:

- Consentimiento del usuario al registrar cuenta y usar la aplicacion.

## Aviso de privacidad breve

Responsable: estudiante desarrollador del proyecto FitPulse.

Datos recabados: nombre, correo, metricas de salud, metas, sesiones e identificadores tecnicos de dispositivos.

Finalidad: operar el ecosistema academico de seguimiento de actividad fisica y demostrar sincronizacion entre dispositivos.

Derechos ARCO: el usuario puede solicitar acceso, rectificacion, cancelacion u oposicion sobre sus datos al responsable del proyecto.

## Retencion de datos

- Cache local de TV: maximo 30 dias; se elimina automaticamente al iniciar la pantalla TV.
- Datos de base de datos: `services/retention.js` se ejecuta al iniciar el backend y una vez al dia. Elimina las lecturas crudas del wearable (`metrics`) con mas de 30 dias y las sesiones con mas de 365 dias (el historial y las metricas mensuales necesitan mas de 30 dias de sesiones).
- Cancelacion: `DELETE /api/profile` (con contrasena) borra la cuenta y, en cascada, metas, sesiones, dispositivos, lecturas y notificaciones.
- Archivos sensibles: `.env`, `.jks`, `.keystore` y logs no deben subirse al repositorio.

## Checklist PWA

- CSP configurada en `frontend/src/index.html`.
- Service Worker Angular activo en build de produccion.
- Cache para estaticos y Network First para datos TV/API.
- HTTPS requerido para despliegue real.
- Iconos 192 y 512 con `any maskable`.
- Validacion de canal SSE con JWT.
