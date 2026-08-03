require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { query } = require('./db');
const fileStore = require('./services/fileStore');
const profileRouter = require('./routes/profile');
const { startRetentionJob } = require('./services/retention');

const filesRouter = require('./routes/files');
const authRouter = require('./routes/auth');
const searchRouter = require('./routes/search');
const devicesRouter = require('./routes/devices');
const tvRouter = require('./routes/tv').router;

const goalsRouter = require('./routes/goals');
const sessionsRouter = require('./routes/sessions');

const app = express();
app.use(cors());
app.use(express.json());

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

// Servir archivos estáticos (previews/downloads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/workspaces/:workspaceId/search', async (req, res) => {
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
app.use('/api/workspaces/:workspaceId/files', filesRouter);
app.use('/api/search', searchRouter);
app.use('/api/auth', authRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/tv', tvRouter);
app.use('/api/profile', profileRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/sessions', sessionsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> {
  console.log(`Server running on http://localhost:${PORT}`);
  startRetentionJob();
});
