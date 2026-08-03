const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
 
const router = express.Router();

let avatarColumnReady = false;

async function ensureAvatarColumn() {
  if (avatarColumnReady) return;
  try {
    await query('ALTER TABLE users ADD COLUMN avatar MEDIUMTEXT NULL');
  } catch (err) {
    if (!err || err.code !== 'ER_DUP_FIELDNAME') {
      throw err;
    }
  }
  avatarColumnReady = true;
}
 
// GET /api/profile
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureAvatarColumn();
    const result = await query(
      'SELECT id, email, name, avatar, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json({ user });
  } catch (err) {
    console.error('Profile get error:', err);
    return res.status(500).json({ error: 'Error al obtener perfil' });
  }
});
 
// PUT /api/profile — actualizar nombre, contraseña o avatar
router.put('/', authMiddleware, async (req, res) => {
  const { name, currentPassword, newPassword, avatar } = req.body;
 
  try {
    await ensureAvatarColumn();
    const result = await query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
 
    let updates = [];
    let values = [];
 
    if (name) {
      updates.push('name = ?');
      values.push(name);
    }
 
    if (avatar !== undefined) {
      // Validar que sea base64 de imagen o null
      if (avatar !== null && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar)) {
        return res.status(400).json({ error: 'Formato de imagen inválido' });
      }
      if (avatar && avatar.length > 2 * 1024 * 1024) {
        return res.status(400).json({ error: 'La imagen no debe superar 1.5MB' });
      }
      updates.push('avatar = ?');
      values.push(avatar);
    }
 
    if (newPassword) {
      if (!currentPassword)
        return res.status(400).json({ error: 'Se requiere la contraseña actual' });
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid)
        return res.status(401).json({ error: 'Contraseña actual incorrecta' });
      const hashed = await bcrypt.hash(newPassword, 12);
      updates.push('password_hash = ?');
      values.push(hashed);
    }
 
    if (updates.length === 0)
      return res.status(400).json({ error: 'Nada que actualizar' });
 
    values.push(req.user.id);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
 
    const updated = await query(
      'SELECT id, email, name, avatar, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
 
    return res.json({ user: updated.rows[0], message: 'Perfil actualizado' });
  } catch (err) {
    console.error('Profile update error:', err);
    return res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});
 
module.exports = router;
