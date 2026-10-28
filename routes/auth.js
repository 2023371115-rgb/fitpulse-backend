const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { optNumber, optInt, sendError } = require('../services/validate');
const { notify } = require('../services/notify');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function sign(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role || 'user',
    weight_kg: u.weight_kg === null || u.weight_kg === undefined ? null : Number(u.weight_kg),
    height_cm: u.height_cm ?? null,
    age: u.age ?? null,
    daily_step_goal: u.daily_step_goal ?? 10000,
    created_at: u.created_at,
  };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    const emailNormalized = String(email || '').trim().toLowerCase();
    const passwordText = String(password || '');
    const nameText = String(name || '').trim();

    if (!emailNormalized || !passwordText.trim()) return res.status(400).json({ error: 'Email y contrasena requeridos.' });
    if (emailNormalized.length > 255 || !EMAIL_RE.test(emailNormalized)) return res.status(400).json({ error: 'Correo no valido.' });
    if (passwordText.length < 8) return res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres.' });
    if (passwordText.length > 72) return res.status(400).json({ error: 'La contrasena admite maximo 72 caracteres.' });
    if (nameText.length > 120) return res.status(400).json({ error: 'El nombre admite maximo 120 caracteres.' });

    const weight = optNumber(req.body.weight_kg, 'weight_kg', 20, 400);
    const height = optInt(req.body.height_cm, 'height_cm', 80, 250);
    const age = optInt(req.body.age, 'age', 10, 120);
    const stepGoal = optInt(req.body.daily_step_goal, 'daily_step_goal', 500, 100000) ?? 10000;

    const hashed = await bcrypt.hash(passwordText, 10);
    const id = uuidv4();
    await query(
      `INSERT INTO users(id, email, password_hash, name, role, weight_kg, height_cm, age, daily_step_goal)
       VALUES(?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
      [id, emailNormalized, hashed, nameText || null, weight, height, age, stepGoal]
    );
    const r = await query('SELECT * FROM users WHERE id = ?', [id]);
    const user = r.rows[0];

    // Meta inicial de pasos para que la app tenga algo que mostrar desde el primer día.
    await query(
      `INSERT INTO goals(id, user_id, type, title, target, unit, period) VALUES(?, ?, 'steps', ?, ?, 'pasos', 'daily')`,
      [uuidv4(), id, `${stepGoal.toLocaleString('en-US')} pasos diarios`, stepGoal]
    );
    await notify(id, 'tip', '¡Bienvenido a FitPulse!', 'Registra tu primera actividad o conecta tu wearable para empezar.');

    return res.status(201).json({ user: publicUser(user), token: sign(user) });
  } catch (err) {
    if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      return res.status(409).json({ error: 'Este correo ya esta registrado. Inicia sesion o usa otro correo.' });
    }
    return sendError(res, err, 'No se pudo crear la cuenta.', 'Register error');
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const emailNormalized = String(email || '').trim().toLowerCase();
    const passwordText = String(password || '');
    if (!emailNormalized || !passwordText) return res.status(400).json({ error: 'Email y contrasena requeridos.' });
    if (emailNormalized.length > 255 || passwordText.length > 72) return res.status(401).json({ error: 'Credenciales incorrectas.' });

    const r = await query('SELECT * FROM users WHERE email = ?', [emailNormalized]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'Credenciales incorrectas.' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(passwordText, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas.' });
    if (Number(user.active) === 0) return res.status(403).json({ error: 'Cuenta desactivada por administracion.' });

    return res.json({ user: publicUser(user), token: sign(user) });
  } catch (err) {
    return sendError(res, err, 'No se pudo iniciar sesion.', 'Login error');
  }
});

module.exports = router;
module.exports.publicUser = publicUser;
