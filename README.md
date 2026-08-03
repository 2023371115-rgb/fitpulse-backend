# FitPulse Backend

API Node/Express + MySQL para FitPulse Health Lab.

## Incluye

- Autenticacion JWT.
- Registro e inicio de sesion.
- Perfil de usuario.
- Metas y sesiones de entrenamiento.
- Dispositivos y metricas de salud.
- Busqueda interna/externa.
- Estado de Smart TV.
- Server-Sent Events para sincronizacion.

## Requisitos

- Node.js
- MySQL local, por ejemplo XAMPP

## Configuracion

Copia `.env.example` a `.env` y ajusta tus credenciales:

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=sketchbook
JWT_SECRET=dev_secret_change_me
```

## Instalacion

```bash
npm install
```

## Migracion

```bash
npm run migrate
```

## Desarrollo

```bash
npm run dev
```

API:

```text
http://localhost:3000
```

Health check:

```text
http://localhost:3000/api/health
```

## Busqueda externa

DuckDuckGo funciona sin credenciales:

```env
EXTERNAL_SEARCH_PROVIDER=duckduckgo
```

## Entrega academica

Este repo cubre backend, base de datos, autenticacion, APIs para dashboard,
buscador, dispositivos inteligentes y sincronizacion con Smart TV/wearable.
