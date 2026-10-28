const express = require('express');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { ensureAdminColumns } = require('../services/userSchema');

const router = express.Router();

/**
 * Solo usuarios con role = 'admin' pueden usar el panel.
 * (Antes bastaba con llamarse "superadmin", y cualquiera podía registrarse con ese nombre.)
 */
async function requireSuperAdmin(req, res, next) {
  try {
    await ensureAdminColumns();
    const result = await query(
      'SELECT id, email, name, role, active FROM users WHERE id = ?',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.role !== 'admin' || Number(user.active) === 0) {
      return res.status(403).json({ error: 'Solo administradores pueden usar este panel.' });
    }
    req.adminUser = user;
    return next();
  } catch (err) {
    console.error('Admin guard error:', err.message);
    return res.status(500).json({ error: 'No se pudo validar el administrador.' });
  }
}

router.use(authMiddleware, requireSuperAdmin);

router.get('/users', async (_req, res) => {
  try {
    await ensureAdminColumns();
    const result = await query(
      `SELECT id, email, name, role, active, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    return res.json({ users: result.rows });
  } catch (err) {
    console.error('Admin list users error:', err);
    return res.status(500).json({ error: 'No se pudieron cargar los usuarios.' });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    await ensureAdminColumns();
    const userId = req.params.id;
    const active = req.body?.active === true || req.body?.active === 1 ? 1 : 0;

    if (userId === req.user.id && active === 0) {
      return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta superadmin.' });
    }

    const result = await query('UPDATE users SET active = ? WHERE id = ?', [active, userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const updated = await query(
      'SELECT id, email, name, role, active, created_at FROM users WHERE id = ?',
      [userId]
    );
    return res.json({ user: updated.rows[0] });
  } catch (err) {
    console.error('Admin update user error:', err);
    return res.status(500).json({ error: 'No se pudo actualizar el usuario.' });
  }
});

module.exports = router;
