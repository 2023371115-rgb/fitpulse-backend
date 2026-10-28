const express = require('express');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { sendError } = require('../services/validate');

const router = express.Router();
router.use(authMiddleware);

// GET /api/notifications?limit=50 — notificaciones del usuario, más recientes primero
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const result = await query(
      `SELECT id, kind, title, body, read_at, created_at, (read_at IS NOT NULL) AS is_read
       FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      [req.user.id]
    );
    const unread = await query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    return res.json({
      unread: Number(unread.rows[0].n),
      items: result.rows.map(n => ({ ...n, read: Boolean(Number(n.is_read)), is_read: undefined })),
    });
  } catch (err) {
    return sendError(res, err, 'Error al obtener notificaciones', 'notifications list error');
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    const r = await query('UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    return res.json({ ok: true, updated: r.rowCount });
  } catch (err) {
    return sendError(res, err, 'Error al actualizar notificaciones', 'notifications read-all error');
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  try {
    const r = await query(
      'UPDATE notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Notificacion no encontrada' });
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, 'Error al actualizar notificacion', 'notification read error');
  }
});

// DELETE /api/notifications/:id
router.delete('/:id', async (req, res) => {
  try {
    const r = await query('DELETE FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Notificacion no encontrada' });
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, 'Error al eliminar notificacion', 'notification delete error');
  }
});

module.exports = router;
