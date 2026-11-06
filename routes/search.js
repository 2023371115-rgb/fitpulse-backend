const express = require('express');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { externalSearch } = require('../services/externalSearch');
const { SearchIndex } = require('../services/searchEngine');
const { sendError } = require('../services/validate');

const router = express.Router();

// ───────── Búsqueda interna (tipo Elasticsearch) ─────────

// Título que ve el usuario y sinónimos que solo sirven para encontrarla.
const SESSION_LABEL = {
  running: ['Carrera', 'correr running trotar'],
  walking: ['Caminata', 'caminar walking'],
  cycling: ['Bicicleta', 'ciclismo bici cycling'],
  gym: ['Fuerza', 'gimnasio pesas gym'],
  swimming: ['Natación', 'nadar alberca swimming'],
  other: ['Actividad', 'otra'],
};
const GOAL_LABEL = {
  steps: 'pasos', calories: 'calorías', heart_rate: 'ritmo cardíaco', weight: 'peso', sleep: 'sueño dormir',
  distance: 'distancia kilómetros', workouts: 'entrenamientos sesiones', active: 'minutos activos',
};
const TICKET_LABEL = {
  bug: 'error fallo bug', crash: 'cierre inesperado crash se cierra', ui: 'diseño pantalla interfaz', performance: 'lento rendimiento',
  data: 'datos información', other: 'otro', open: 'abierto', in_progress: 'en revisión', resolved: 'resuelto', closed: 'cerrado',
  low: 'baja', medium: 'media', high: 'alta', critical: 'crítica',
};
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Secciones de la app, para poder buscar "reportar fallo" y llegar a la pantalla. */
const SCREENS = [
  ['home', 'Inicio', 'Resumen del día, pasos, ritmo cardíaco y calorías'],
  ['activity', 'Actividad física', 'Iniciar entrenamiento, cronómetro, correr, caminar, bicicleta'],
  ['goals', 'Metas', 'Crear y seguir metas diarias y semanales de pasos, distancia y sueño'],
  ['sessions', 'Sesiones', 'Historial de entrenamientos registrados'],
  ['metrics', 'Métricas', 'Gráficas de pasos por día, ritmo en reposo y tiempo por actividad'],
  ['devices', 'Dispositivos', 'Vincular wearable, smartwatch o banda y sincronizar'],
  ['notifications', 'Notificaciones', 'Avisos de metas cumplidas, sincronización y batería'],
  ['tickets', 'Reportar un fallo', 'Enviar un ticket de error, problema o falla de la aplicación y ver su estado'],
  ['profile', 'Perfil', 'Datos personales, peso, estatura, contraseña y cerrar sesión'],
];

function fecha(d) {
  if (!d) return '';
  const x = new Date(d);
  return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} de ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

async function buildIndex(userId, isAdmin) {
  const index = new SearchIndex({ title: 3, tags: 2, body: 1 });
  const [sessions, goals, notifications, devices, tickets] = await Promise.all([
    query(`SELECT id, type, started_at, ended_at, distance_km, calories, avg_heart_rate, notes, device_name
           FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 500`, [userId]),
    query('SELECT id, type, title, target, unit, period, active FROM goals WHERE user_id = ?', [userId]),
    query('SELECT id, kind, title, body, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 300', [userId]),
    query('SELECT id, name, type, status, battery, last_sync_at FROM devices WHERE owner_id = ?', [userId]),
    isAdmin
      ? query('SELECT id, folio, title, description, category, severity, status, screen, platform, created_at FROM tickets ORDER BY created_at DESC LIMIT 1000')
      : query('SELECT id, folio, title, description, category, severity, status, screen, platform, created_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC', [userId]),
  ]);

  for (const s of sessions.rows) {
    const km = s.distance_km === null ? '' : `${Number(s.distance_km)} km`;
    index.add({
      _index: 'sessions', _id: s.id,
      fields: {
        title: (SESSION_LABEL[s.type] || [s.type])[0],
        tags: `${(SESSION_LABEL[s.type] || ['', ''])[1]} ${fecha(s.started_at)} ${km} ${s.device_name || ''}`,
        body: `${s.notes || ''} ${s.avg_heart_rate ? s.avg_heart_rate + ' bpm' : ''} ${s.calories ? Math.round(s.calories) + ' kcal' : ''}`,
      },
      source: { id: s.id, type: s.type, title: (SESSION_LABEL[s.type] || [s.type])[0], started_at: s.started_at, ended_at: s.ended_at, distance_km: s.distance_km === null ? null : Number(s.distance_km), calories: s.calories === null ? null : Number(s.calories), notes: s.notes },
    });
  }
  for (const g of goals.rows) {
    index.add({
      _index: 'goals', _id: g.id,
      fields: { title: g.title || GOAL_LABEL[g.type] || g.type, tags: `${GOAL_LABEL[g.type] || ''} ${g.period === 'weekly' ? 'semanal semana' : 'diaria hoy'}`, body: `${Number(g.target)} ${g.unit}` },
      source: { id: g.id, type: g.type, title: g.title, target: Number(g.target), unit: g.unit, period: g.period, active: Boolean(Number(g.active)) },
    });
  }
  for (const n of notifications.rows) {
    index.add({
      _index: 'notifications', _id: n.id,
      fields: { title: n.title, body: n.body, tags: fecha(n.created_at) },
      source: { id: n.id, kind: n.kind, title: n.title, body: n.body, created_at: n.created_at },
    });
  }
  for (const d of devices.rows) {
    index.add({
      _index: 'devices', _id: d.id,
      fields: { title: d.name, tags: `${d.type === 'wearable' ? 'wearable reloj smartwatch banda' : d.type} ${d.status === 'linked' ? 'vinculado conectado' : d.status}` },
      source: { id: d.id, name: d.name, type: d.type, status: d.status, battery: d.battery, last_sync_at: d.last_sync_at },
    });
  }
  for (const t of tickets.rows) {
    const code = `FP-${String(t.folio).padStart(4, '0')}`;
    index.add({
      _index: 'tickets', _id: t.id,
      fields: {
        title: `${t.title} ${code}`,
        tags: `${TICKET_LABEL[t.category] || ''} ${TICKET_LABEL[t.status] || ''} ${TICKET_LABEL[t.severity] || ''} ${t.screen || ''} ${t.platform || ''}`,
        body: t.description,
      },
      source: { id: t.id, code, title: t.title, category: t.category, severity: t.severity, status: t.status, created_at: t.created_at },
    });
  }
  if (isAdmin) {
    const users = await query('SELECT id, name, email, role, active FROM users ORDER BY created_at DESC LIMIT 1000');
    for (const u of users.rows) {
      index.add({
        _index: 'users', _id: u.id,
        fields: { title: `${u.name || ''} ${u.email}`, tags: u.role === 'admin' ? 'administrador admin' : 'usuario' },
        source: { id: u.id, name: u.name, email: u.email, role: u.role, active: Boolean(Number(u.active)) },
      });
    }
  }
  for (const [id, title, body] of SCREENS) {
    index.add({ _index: 'screens', _id: id, fields: { title, body }, source: { id, title, description: body } });
  }
  return index;
}

// GET /api/search?q=correr&index=sessions,goals&size=20
router.get('/', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').toString().trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'Escribe qué quieres buscar (parámetro q)' });
  try {
    const roleRow = await query('SELECT role FROM users WHERE id = ?', [req.user.id]);
    const isAdmin = roleRow.rows[0]?.role === 'admin';
    const indices = req.query.index ? String(req.query.index).split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const size = Math.min(Math.max(Number(req.query.size) || 20, 1), 100);
    const index = await buildIndex(req.user.id, isAdmin);
    return res.json(index.search(q, { size, indices }));
  } catch (err) {
    return sendError(res, err, 'No se pudo completar la búsqueda', 'search error');
  }
});

// ───────── Búsqueda externa (web) ─────────
router.get('/external', async (req, res) => {
  const query = (req.query.q || '').toString().trim();
  const type = (req.query.type || 'web').toString();
  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const results = await externalSearch(query, { type });
    return res.json(results);
  } catch (err) {
    console.error('External search failed:', err?.message || err);
    return res.status(500).json({ error: 'External search failed', details: err?.message || String(err) });
  }
});

module.exports = router;
