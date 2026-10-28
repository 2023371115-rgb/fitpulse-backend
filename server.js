require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { query } = db;
const authMiddleware = require('./middleware/auth');
const fileStore = require('./services/fileStore');
const profileRouter = require('./routes/profile');
const { startRetentionJob } = require('./services/retention');

const filesRouter = require('./routes/files');
const authRouter = require('./routes/auth');
const searchRouter = require('./routes/search');
const devicesRouter = require('./routes/devices');
const tvRouter = require('./routes/tv').router;
const adminRouter = require('./routes/admin');

const goalsRouter = require('./routes/goals');
const sessionsRouter = require('./routes/sessions');
const metricsRouter = require('./routes/metrics');
const notificationsRouter = require('./routes/notifications');

const app = express();
app.use(cors());
app.use(express.json({ limit: '3mb' }));

const appVersion = {
  name: 'FitPulse Health Lab',
  version: '1.1.0',
  stage: 'stable',
  releasedAt: '2026-10-27',
  services: {
    frontend: 'Vercel',
    backend: 'Render',
    database: 'Aiven MySQL',
    wearable: 'Flutter Wear OS'
  }
};

// Rate limiting — protege login y subida de archivos
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutos
  max: 20,                    // máx 20 intentos de login por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' }
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minuto
  max: 30,                    // máx 30 subidas por minuto por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de subidas alcanzado. Espera un momento.' }
});
app.use('/api/auth', authLimiter);
app.use('/api/workspaces/:workspaceId/files', uploadLimiter);

// Design tokens — compartidos con Angular (CSS variables) y Flutter
const tokens = require('./data/tokens.json');
app.get('/api/tokens', (_req, res) => res.json(tokens));
app.get('/api/version', (_req, res) => res.json(appVersion));
app.get('/api/health', (_req, res) => res.json({ ok: true, ...appVersion }));

// Servir archivos estáticos (previews/downloads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/workspaces/:workspaceId/search', authMiddleware, async (req, res) => {
  const workspaceId = req.params.workspaceId || 'default';
  const searchTerm = (req.query.q || '').toString().trim();
  if (!searchTerm) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  const likePattern = `%${searchTerm.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

  try {
    const result = await query(
      `SELECT id, workspace_id, original_name, filename, mime_type, size, storage_path, thumbnail_url, metadata, created_at
       FROM files
       WHERE workspace_id = ?
         AND (
           original_name LIKE ?
           OR filename LIKE ?
           OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.description')), '') LIKE ?
           OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.tags')), '') LIKE ?
         )
       ORDER BY created_at DESC
       LIMIT 100`,
      [workspaceId, likePattern, likePattern, likePattern, likePattern]
    );

    return res.json(result.rows);
  } catch (err) {
    console.warn('Database unavailable; using local file store for search:', err.message);
    const results = fileStore.listFiles(workspaceId).filter(file => {
      const candidate = `${file.original_name || ''} ${file.filename || ''} ${(file.metadata && file.metadata.description) || ''} ${(file.metadata && file.metadata.tags) || ''}`.toLowerCase();
      return candidate.includes(searchTerm.toLowerCase());
    });
    return res.json(results);
  }
});




// Rutas
app.use('/api/workspaces/:workspaceId/files', authMiddleware, filesRouter);
app.use('/api/search', searchRouter);
app.use('/api/auth', authRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/tv', tvRouter);
app.use('/api/profile', profileRouter);
app.use('/api/admin', adminRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/notifications', notificationsRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
// Errores no controlados (por ejemplo, JSON mal formado)
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('Unhandled error:', err.message);
  const message = status === 400 ? 'Solicitud invalida' : status === 413 ? 'Solicitud demasiado grande' : status < 500 ? 'Solicitud rechazada' : 'Error interno del servidor';
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    const applied = await db.migrate();
    console.log(applied.length ? `Schema updated: ${applied.join(', ')}` : 'Schema up to date');
  } catch (err) {
    console.warn('Schema check skipped (database unavailable?):', err.message);
  }
  return app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    startRetentionJob();
  });
}

if (require.main === module) {
  start();
}

module.exports = app;
module.exports.start = start;
