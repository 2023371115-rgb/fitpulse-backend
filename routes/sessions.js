const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const sessionTypes = new Set(['running', 'cycling', 'walking', 'gym', 'swimming', 'other']);

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) AS total_sessions,
         COALESCE(SUM(steps), 0) AS total_steps,
         COALESCE(SUM(calories), 0) AS total_calories,
         COALESCE(AVG(avg_heart_rate), 0) AS avg_heart_rate,
         COALESCE(SUM(
           CASE
             WHEN ended_at IS NULL THEN 0
             ELSE TIMESTAMPDIFF(MINUTE, started_at, ended_at)
           END
         ), 0) AS total_minutes
       FROM sessions
       WHERE user_id = ?
         AND started_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      [req.user.id]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('sessions summary error', err);
    return res.status(500).json({ error: 'Error al obtener resumen' });
  }
});

router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, type, started_at, ended_at, steps, calories, avg_heart_rate, notes, NULL AS device_name
       FROM sessions
       WHERE user_id = ?
       ORDER BY started_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('sessions list error', err);
    return res.status(500).json({ error: 'Error al obtener sesiones' });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const {
      type,
      started_at,
      ended_at,
      steps,
      calories,
      avg_heart_rate,
      notes,
    } = req.body;

    if (!started_at) return res.status(400).json({ error: 'Fecha de inicio requerida' });

    const sessionType = sessionTypes.has(type) ? type : 'other';
    const id = uuidv4();

    await query(
      `INSERT INTO sessions(
         id, user_id, type, started_at, ended_at, steps, calories,
         avg_heart_rate, notes
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.user.id,
        sessionType,
        started_at,
        ended_at || null,
        optionalNumber(steps),
        optionalNumber(calories),
        optionalNumber(avg_heart_rate),
        notes || null
      ]
    );

    const result = await query(
      `SELECT id, type, started_at, ended_at, steps, calories, avg_heart_rate, notes, NULL AS device_name
       FROM sessions
       WHERE id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('session create error', err);
    return res.status(500).json({ error: 'Error al registrar sesion' });
  }
});

router.delete('/:sessionId', authMiddleware, async (req, res) => {
  try {
    await query(
      'DELETE FROM sessions WHERE id = ? AND user_id = ?',
      [req.params.sessionId, req.user.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('session delete error', err);
    return res.status(500).json({ error: 'Error al eliminar sesion' });
  }
});

module.exports = router;
