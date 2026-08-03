const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const goalTypes = new Set(['steps', 'calories', 'heart_rate', 'weight', 'sleep']);

router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, type, target, unit, active, created_at
       FROM goals
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('goals list error', err);
    return res.status(500).json({ error: 'Error al obtener metas' });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { type, target, unit } = req.body;
    const numericTarget = Number(target);

    if (!goalTypes.has(type)) return res.status(400).json({ error: 'Tipo de meta invalido' });
    if (!Number.isFinite(numericTarget) || numericTarget <= 0) {
      return res.status(400).json({ error: 'Valor de meta invalido' });
    }

    const id = uuidv4();
    await query(
      `INSERT INTO goals(id, user_id, type, target, unit)
       VALUES(?, ?, ?, ?, ?)`,
      [id, req.user.id, type, numericTarget, unit || '']
    );

    const result = await query(
      `SELECT id, type, target, unit, active, created_at
       FROM goals
       WHERE id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('goal create error', err);
    return res.status(500).json({ error: 'Error al agregar meta' });
  }
});

router.patch('/:goalId', authMiddleware, async (req, res) => {
  try {
    const active = req.body.active ? 1 : 0;
    await query(
      'UPDATE goals SET active = ? WHERE id = ? AND user_id = ?',
      [active, req.params.goalId, req.user.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('goal update error', err);
    return res.status(500).json({ error: 'Error al actualizar meta' });
  }
});

router.delete('/:goalId', authMiddleware, async (req, res) => {
  try {
    await query(
      'DELETE FROM goals WHERE id = ? AND user_id = ?',
      [req.params.goalId, req.user.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('goal delete error', err);
    return res.status(500).json({ error: 'Error al eliminar meta' });
  }
});

module.exports = router;
