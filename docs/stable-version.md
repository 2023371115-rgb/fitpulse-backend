# FitPulse Health Lab - Version estable

## Version

- Nombre: FitPulse Health Lab
- Version estable: 1.0.0
- Fecha de cierre: 2026-08-13
- Estado: estable para defensa de proyecto

## Repositorios

- Frontend Angular: https://github.com/2023371115-rgb/fitpulse-frontend
- Backend Node/Express: https://github.com/2023371115-rgb/fitpulse-backend
- App Wear OS Flutter: https://github.com/2023371115-rgb/fitpulse-wearos

## Despliegues

- Frontend: Vercel
- Backend: https://fitpulse-backend-r77o.onrender.com
- Base de datos: Aiven MySQL
- Endpoint de version: https://fitpulse-backend-r77o.onrender.com/api/version
- Endpoint de salud: https://fitpulse-backend-r77o.onrender.com/api/health

## Comprobacion tecnica de version

Ejecutar:

```powershell
curl.exe https://fitpulse-backend-r77o.onrender.com/api/version
curl.exe https://fitpulse-backend-r77o.onrender.com/api/health
```

Resultado esperado:

- `version` debe ser `1.1.0` (Entregable 2: metas con avance, sesiones con distancia, métricas y notificaciones).
- `stage` debe ser `stable`.
- `services.database` debe indicar `Aiven MySQL`.
- `ok` debe ser `true` en `/api/health`.

## Alcance estable

- Login y registro con JWT.
- Perfil con nombre, avatar y cambio de contrasena.
- Terminos y uso.
- Menu hamburguesa responsive.
- Dashboard de metas y sesiones.
- Dashboard Smart TV con SSE.
- Panel de dispositivos inteligentes.
- Enlace de wearable y carga de metricas.
- App Flutter Wear OS con modo demo y conexion API.

## Limitacion conocida

El buscador externo usa DuckDuckGo Instant Answer. Algunas consultas no devuelven respuesta directa y se muestra enlace externo para abrir la busqueda. Si se requiere buscador independiente avanzado, se puede reforzar con Fuse.js o Elasticsearch.
