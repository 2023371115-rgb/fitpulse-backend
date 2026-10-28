const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { activeGoals, withProgress } = require('../services/goalProgress');
const { notify } = require('../services/notify');
const { tzOffset, parseDate } = require('../services/time');
const { optNumber, optInt, optText, sendError, ValidationError } = require('../services/validate');

const router = express.Router();

const sessionTypes = new Set(['running', 'cycling', 'walking', 'gym', 'swimming', 'other']);
const TYPE_TITLE = { running: 'Carrera', walking: 'Caminata', cycling: 'Bicicleta', gym: 'Fuerza', swimming: 'Natación', other: 'Actividad' };
const HIGH_HR = 175;

const FIELDS = `id, type, started_at, ended_at, distance_km, steps, calories, avg_heart_rate, max_heart_rate,
  notes, device_name, created_at,
  CASE WHEN ended_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(SECOND, started_at, ended_at) END AS duration_sec`;

function shape(row, { withSamples = false } = {}) {
  const s = {
    ...row,
    distance_km: row.distance_km === null ? null : Number(row.distance_km),
    calories: row.calories === null ? null : Number(row.calories),
    duration_sec: row.duration_sec === null ? null : Number(row.duration_sec),
    duration_min: row.duration_sec === null ? null : Math.round(Number(row.duration_sec) / 60),
  };
  if (withSamples) {
    let samples = row.hr_samples;
    if (typeof samples === 'string') {
      try { samples = JSON.parse(samples); } catch { samples = []; }
    }
    s.hr_samples = Array.isArray(samples) ? samples : [];
  } else {
    delete s.hr_samples;
  }
  return s;
}

function fmtDuration(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// GET /api/sessions/summary — últimos 7 días (usado también por la web y la TV)
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const result = await query(
      `SELECT
         COUNT(*) AS total_sessions,
         COALESCE(SUM(steps), 0) AS total_steps,
         COALESCE(SUM(calories), 0) AS total_calories,
         COALESCE(SUM(distance_km), 0) AS total_km,
         COALESCE(AVG(avg_heart_rate), 0) AS avg_heart_rate,
         COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 0 ELSE TIMESTAMPDIFF(MINUTE, started_at, ended_at) END), 0) AS total_minutes
       FROM sessions
       WHERE user_id = ? AND started_at >= ?`,
      [req.user.id, since]
    );
    const r = result.rows[0];
    return res.json({
      total_sessions: Number(r.total_sessions),
      total_steps: Number(r.total_steps),
      total_calories: Number(r.total_calories),
      total_km: Number(r.total_km),
      avg_heart_rate: Math.round(Number(r.avg_heart_rate)),
      total_minutes: Number(r.total_minutes),
    });
  } catch (err) {
    return sendError(res, err, 'Error al obtener resumen', 'sessions summary error');
  }
});

// GET /api/sessions?type=running&from=2026-10-01&limit=50
router.get('/', authMiddleware, async (req, res) => {
  try {
    const where = ['user_id = ?'];
    const params = [req.user.id];
    if (req.query.type) {
      if (!sessionTypes.has(req.query.type)) return res.status(400).json({ error: 'Tipo de sesion invalido' });
      where.push('type = ?');
      params.push(req.query.type);
    }
    const from = parseDate(req.query.from);
    if (from) { where.push('started_at >= ?'); params.push(from); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);

    const result = await query(
      `SELECT ${FIELDS} FROM sessions WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ${limit}`,
      params
    );
    return res.json(result.rows.map(r => shape(r)));
  } catch (err) {
    return sendError(res, err, 'Error al obtener sesiones', 'sessions list error');
  }
});

// GET /api/sessions/:sessionId — incluye las muestras de ritmo cardíaco
router.get('/:sessionId', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT ${FIELDS}, hr_samples FROM sessions WHERE id = ? AND user_id = ?`,
      [req.params.sessionId, req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Sesion no encontrada' });
    return res.json(shape(result.rows[0], { withSamples: true }));
  } catch (err) {
    return sendError(res, err, 'Error al obtener sesion', 'session get error');
  }
});

// POST /api/sessions — registra una sesión de actividad
router.post('/', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const startedAt = parseDate(b.started_at);
    if (!startedAt) return res.status(400).json({ error: 'Fecha de inicio requerida' });

    let endedAt = parseDate(b.ended_at);
    const durationSec = optInt(b.duration_sec, 'duration_sec', 1, 24 * 3600);
    if (!endedAt && durationSec) endedAt = new Date(startedAt.getTime() + durationSec * 1000);
    if (endedAt && endedAt < startedAt) return res.status(400).json({ error: 'La fecha de fin es anterior al inicio' });
    if (startedAt.getTime() > Date.now() + 5 * 60_000) return res.status(400).json({ error: 'La sesion no puede empezar en el futuro' });

    const type = sessionTypes.has(b.type) ? b.type : 'other';
    const distance = optNumber(b.distance_km, 'distance_km', 0, 500);
    const steps = optInt(b.steps, 'steps', 0, 200000);
    const calories = optNumber(b.calories, 'calories', 0, 20000);
    const avgHr = optInt(b.avg_heart_rate, 'avg_heart_rate', 25, 250);
    const maxHr = optInt(b.max_heart_rate, 'max_heart_rate', 25, 250);
    const notes = optText(b.notes, 'notes', 500);
    const deviceName = optText(b.device_name, 'device_name', 120);

    let samples = null;
    if (b.hr_samples !== undefined && b.hr_samples !== null) {
      if (!Array.isArray(b.hr_samples) || b.hr_samples.length > 720) {
        throw new ValidationError('hr_samples debe ser una lista de hasta 720 valores');
      }
      samples = b.hr_samples.map(v => optInt(v, 'hr_samples', 25, 250)).filter(v => v !== null);
    }

    // Avance de metas antes de guardar, para detectar las que se cumplen con esta sesión.
    const offset = tzOffset(req);
    const goals = await activeGoals(req.user.id);
    const before = await withProgress(req.user.id, goals, offset, new Date(), { history: false });

    const id = uuidv4();
    await query(
      `INSERT INTO sessions(id, user_id, type, started_at, ended_at, distance_km, steps, calories,
         avg_heart_rate, max_heart_rate, hr_samples, notes, device_name)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, type, startedAt, endedAt, distance, steps, calories, avgHr, maxHr,
        samples ? JSON.stringify(samples) : null, notes, deviceName]
    );

    const result = await query(`SELECT ${FIELDS}, hr_samples FROM sessions WHERE id = ?`, [id]);
    const session = shape(result.rows[0], { withSamples: true });

    // Notificaciones generadas por la sesión
    const parts = [];
    if (session.duration_sec) parts.push(fmtDuration(session.duration_sec));
    if (distance) parts.push(`${distance.toFixed(1)} km`);
    await notify(req.user.id, 'session', 'Sesión guardada', `${TYPE_TITLE[type]}${parts.length ? ' · ' + parts.join(' · ') : ''}`);
    if (maxHr && maxHr >= HIGH_HR) {
      await notify(req.user.id, 'heart', 'Ritmo cardíaco alto', `Alcanzaste ${maxHr} bpm. Recuerda hidratarte y descansar.`);
    }
    const after = await withProgress(req.user.id, goals, offset, new Date(), { history: false });
    const completed = after.filter(g => g.done && !before.find(b2 => b2.id === g.id)?.done);
    for (const g of completed) {
      await notify(req.user.id, 'goal', '¡Meta cumplida!', `Completaste "${g.title || g.type}". ¡Sigue así!`);
    }

    return res.status(201).json({ ...session, goals_completed: completed.map(g => g.id) });
  } catch (err) {
    return sendError(res, err, 'Error al registrar sesion', 'session create error');
  }
});

// DELETE /api/sessions/:sessionId
router.delete('/:sessionId', authMiddleware, async (req, res) => {
  try {
    const r = await query('DELETE FROM sessions WHERE id = ? AND user_id = ?', [req.params.sessionId, req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Sesion no encontrada' });
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, 'Error al eliminar sesion', 'session delete error');
  }
});

module.exports = router;
