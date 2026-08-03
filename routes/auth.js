const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const emailNormalized = String(email || '').trim().toLowerCase();
    const passwordText = String(password || '');
    const nameText = String(name || '').trim();

    if(!emailNormalized || !passwordText) return res.status(400).json({ error: 'Email y contrasena requeridos.' });
    if(passwordText.length < 8) return res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres.' });

    const hashed = await bcrypt.hash(passwordText, 10);
    const id = uuidv4();
    await query('INSERT INTO users(id, email, password_hash, name) VALUES(?,?,?,?)', [id, emailNormalized, hashed, nameText || null]);
    const selectUser = await query('SELECT id, email, name, created_at FROM users WHERE id = ?', [id]);
    const user = selectUser.rows[0];
    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
    return res.status(201).json({ user, token });
  } catch (err) {
    console.error('Register error', err);
    if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      return res.status(409).json({ error: 'Este correo ya esta registrado. Inicia sesion o usa otro correo.' });
    }
    return res.status(500).json({ error: 'register failed', details: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const emailNormalized = String(email || '').trim().toLowerCase();
    const passwordText = String(password || '');
    if(!emailNormalized || !passwordText) return res.status(400).json({ error: 'Email y contrasena requeridos.' });

    const r = await query('SELECT id, email, password_hash, name FROM users WHERE email = ?', [emailNormalized]);
    if(r.rowCount === 0) return res.status(401).json({ error: 'Credenciales incorrectas.' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(passwordText, user.password_hash);
    if(!ok) return res.status(401).json({ error: 'Credenciales incorrectas.' });

    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
    return res.json({ user: { id: user.id, email: user.email, name: user.name }, token });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ error: 'login failed', details: err.message });
  }
});

module.exports = router;
