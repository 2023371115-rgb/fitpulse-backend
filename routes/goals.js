const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { withProgress } = require('../services/goalProgress');
const { tzOffset } = require('../services/time');
const { optNumber, optText, sendError } = require('../services/validate');

const router = express.Router();

const GOAL_TYPES = {
  steps: 'pasos',
  distance: 'km',
  workouts: 'entrenamientos',
  calories: 'kcal',
  active: 'min',
  sleep: 'horas',
  heart_rate: 'bpm',
  weight: 'kg',
};
const PERIODS = new Set(['daily', 'weekly']);
const FIELDS = 'id, type, title, target, unit, period, manual_value, active, created_at';

function defaultTitle(type, target, period) {
  const v = Number.isInteger(target) ? target.toLocaleString('en-US') : String(target);
  const p = period === 'weekly' ? ' por semana' : ' al día';
  switch (type) {
    case 'steps': return `${v} pasos ${period === 'weekly' ? 'por semana' : 'diarios'}`;
    case 'distance': return `Recorrer ${v} km${p}`;
    case 'workouts': return `${v} entrenamientos${period === 'weekly' ? '' : ' al día'}`;
    case 'calories': return `Quemar ${v} kcal${p}`;
    case 'active': return `${v} min activos${p}`;
    case 'sleep': return `Dormir ${v} horas`;
    default: return `${GOAL_TYPES[type] || type}: ${v}`;
  }
}

async function loadGoal(id, userId) {
  const r = await query(`SELECT ${FIELDS} FROM goals WHERE id = ? AND user_id = ?`, [id, userId]);
  return r.rows[0] || null;
}

// GET /api/goals — metas del usuario con su avance (current, progress, done, history)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT ${FIELDS} FROM goals WHERE user_id = ? ORDER BY created_at ASC`,
      [req.user.id]
    );
    const history = req.query.history !== '0';
    return res.json(await withProgress(req.user.id, result.rows, tzOffset(req), new Date(), { history }));
  } catch (err) {
    return sendError(res, err, 'Error al obtener metas', 'goals list error');
  }
});

// POST /api/goals
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { type } = req.body || {};
    if (!GOAL_TYPES[type]) return res.status(400).json({ error: 'Tipo de meta invalido' });

    const target = optNumber(req.body.target, 'target', 0.01, 1000000);
    if (target === null) return res.status(400).json({ error: 'Valor de meta invalido' });

    const period = PERIODS.has(req.body.period) ? req.body.period : 'daily';
    const title = optText(req.body.title, 'title', 120) || defaultTitle(type, target, period);
    const unit = optText(req.body.unit, 'unit', 40) || GOAL_TYPES[type];

    const id = uuidv4();
    await query(
      `INSERT INTO goals(id, user_id, type, title, target, unit, period) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, type, title, target, unit, period]
    );
    const [goal] = await withProgress(req.user.id, [await loadGoal(id, req.user.id)], tzOffset(req));
    return res.status(201).json(goal);
  } catch (err) {
    return sendError(res, err, 'Error al agregar meta', 'goal create error');
  }
});

// PATCH /api/goals/:goalId — activar/desactivar, cambiar objetivo o título,
// o registrar el avance manual (sueño, peso).
router.patch('/:goalId', authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];
    if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active ? 1 : 0); }
    if (body.target !== undefined) {
      const target = optNumber(body.target, 'target', 0.01, 1000000);
      if (target === null) return res.status(400).json({ error: 'Valor de meta invalido' });
      updates.push('target = ?'); values.push(target);
    }
    if (body.title !== undefined) {
      const title = optText(body.title, 'title', 120);
      if (!title) return res.status(400).json({ error: 'El titulo no puede estar vacio' });
      updates.push('title = ?'); values.push(title);
    }
    if (body.manual_value !== undefined) {
      updates.push('manual_value = ?'); values.push(optNumber(body.manual_value, 'manual_value', 0, 1000000));
    }
    if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });

    values.push(req.params.goalId, req.user.id);
    const r = await query(`UPDATE goals SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, values);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Meta no encontrada' });

    const [goal] = await withProgress(req.user.id, [await loadGoal(req.params.goalId, req.user.id)], tzOffset(req));
    return res.json({ ok: true, goal });
  } catch (err) {
    return sendError(res, err, 'Error al actualizar meta', 'goal update error');
  }
});

// DELETE /api/goals/:goalId
router.delete('/:goalId', authMiddleware, async (req, res) => {
  try {
    const r = await query('DELETE FROM goals WHERE id = ? AND user_id = ?', [req.params.goalId, req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Meta no encontrada' });
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, 'Error al eliminar meta', 'goal delete error');
  }
});

module.exports = router;
module.exports.defaultTitle = defaultTitle;
