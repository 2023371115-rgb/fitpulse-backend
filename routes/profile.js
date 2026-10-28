const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { optNumber, optInt, optText, sendError } = require('../services/validate');

const router = express.Router();

const FIELDS = 'id, email, name, avatar, role, weight_kg, height_cm, age, daily_step_goal, active, created_at';

function shape(u) {
  return {
    ...u,
    role: u.role || 'user',
    weight_kg: u.weight_kg === null ? null : Number(u.weight_kg),
  };
}

// GET /api/profile
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await query(`SELECT ${FIELDS} FROM users WHERE id = ?`, [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json({ user: shape(user) });
  } catch (err) {
    return sendError(res, err, 'Error al obtener perfil', 'Profile get error');
  }
});

// PUT /api/profile — nombre, datos físicos, meta diaria, contraseña o avatar
router.put('/', authMiddleware, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const updates = [];
    const values = [];
    const set = (col, val) => { updates.push(`${col} = ?`); values.push(val); };

    if (body.name !== undefined) {
      const name = optText(body.name, 'name', 120);
      if (!name) return res.status(400).json({ error: 'El nombre no puede estar vacio' });
      set('name', name);
    }
    if (body.weight_kg !== undefined) set('weight_kg', optNumber(body.weight_kg, 'weight_kg', 20, 400));
    if (body.height_cm !== undefined) set('height_cm', optInt(body.height_cm, 'height_cm', 80, 250));
    if (body.age !== undefined) set('age', optInt(body.age, 'age', 10, 120));
    if (body.daily_step_goal !== undefined) {
      const goal = optInt(body.daily_step_goal, 'daily_step_goal', 500, 100000);
      if (goal === null) return res.status(400).json({ error: 'daily_step_goal requerido' });
      set('daily_step_goal', goal);
    }

    if (body.avatar !== undefined) {
      const avatar = body.avatar;
      if (avatar !== null && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar)) {
        return res.status(400).json({ error: 'Formato de imagen inválido' });
      }
      if (avatar && avatar.length > 2 * 1024 * 1024) {
        return res.status(400).json({ error: 'La imagen no debe superar 1.5MB' });
      }
      set('avatar', avatar);
    }

    if (body.newPassword) {
      if (!body.currentPassword) return res.status(400).json({ error: 'Se requiere la contraseña actual' });
      if (String(body.newPassword).length < 8 || String(body.newPassword).length > 72) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener entre 8 y 72 caracteres' });
      }
      const valid = await bcrypt.compare(String(body.currentPassword), user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
      set('password_hash', await bcrypt.hash(String(body.newPassword), 12));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    values.push(req.user.id);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

    // La meta diaria de pasos del perfil se refleja en la meta de pasos diaria.
    if (body.daily_step_goal !== undefined) {
      const goal = Math.round(Number(body.daily_step_goal));
      await query(
        `UPDATE goals SET target = ?, title = ? WHERE user_id = ? AND type = 'steps' AND period = 'daily'`,
        [goal, `${goal.toLocaleString('en-US')} pasos diarios`, req.user.id]
      );
    }

    const updated = await query(`SELECT ${FIELDS} FROM users WHERE id = ?`, [req.user.id]);
    return res.json({ user: shape(updated.rows[0]), message: 'Perfil actualizado' });
  } catch (err) {
    return sendError(res, err, 'Error al actualizar perfil', 'Profile update error');
  }
});

// DELETE /api/profile — elimina la cuenta y todos sus datos (derecho de cancelación, LFPDPPP).
// Requiere confirmar la contraseña actual.
router.delete('/', authMiddleware, async (req, res) => {
  try {
    const password = String((req.body || {}).password || '');
    if (!password) return res.status(400).json({ error: 'Confirma tu contraseña para eliminar la cuenta' });
    const r = await query('SELECT password_hash, role FROM users WHERE id = ?', [req.user.id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    if (user.role === 'admin') return res.status(403).json({ error: 'Una cuenta de administrador no se puede eliminar desde la app' });
    await query('DELETE FROM users WHERE id = ?', [req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, 'No se pudo eliminar la cuenta', 'Profile delete error');
  }
});

module.exports = router;
