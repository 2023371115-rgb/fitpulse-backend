const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const verifyToken = require('../middleware/auth');
const { setState } = require('../services/tvSync');

const router = express.Router();

// ─── DEVICES ──────────────────────────────────────────────────────────────────

// GET /api/devices  — lista dispositivos del usuario autenticado
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, type, status, created_at FROM devices WHERE owner_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('devices list error', err);
    return res.status(500).json({ error: 'Error al obtener dispositivos' });
  }
});

// POST /api/devices  — registra un nuevo dispositivo y devuelve su token
router.post('/', verifyToken, async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name) return res.status(400).json({ error: 'name requerido' });

    const id = uuidv4();
    const token = crypto.randomBytes(32).toString('hex');
    const deviceType = ['wearable', 'smarttv', 'phone', 'other'].includes(type) ? type : 'other';

    await query(
      'INSERT INTO devices(id, owner_id, name, type, token) VALUES(?,?,?,?,?)',
      [id, req.user.id, name, deviceType, token]
    );

    return res.status(201).json({ id, name, type: deviceType, status: 'idle', token });
  } catch (err) {
    console.error('device register error', err);
    return res.status(500).json({ error: 'Error al registrar dispositivo' });
  }
});

// PATCH /api/devices/:deviceId/status  — cambia estado (idle/linked/offline)
router.patch('/:deviceId/status', verifyToken, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['idle', 'linked', 'offline'].includes(status)) {
      return res.status(400).json({ error: 'status inválido' });
    }
    await query(
      'UPDATE devices SET status = ? WHERE id = ? AND owner_id = ?',
      [status, req.params.deviceId, req.user.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('device status error', err);
    return res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

// DELETE /api/devices/:deviceId
router.delete('/:deviceId', verifyToken, async (req, res) => {
  try {
    await query(
      'DELETE FROM devices WHERE id = ? AND owner_id = ?',
      [req.params.deviceId, req.user.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('device delete error', err);
    return res.status(500).json({ error: 'Error al eliminar dispositivo' });
  }
});

// ─── METRICS ──────────────────────────────────────────────────────────────────

// POST /api/devices/:deviceId/metrics/user — app Wear OS autenticada envia demo/sensores
router.post('/:deviceId/metrics/user', verifyToken, async (req, res) => {
  try {
    const deviceResult = await query(
      'SELECT id, owner_id FROM devices WHERE id = ? AND owner_id = ?',
      [req.params.deviceId, req.user.id]
    );
    if (deviceResult.rowCount === 0) {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    const { heart_rate, steps, spo2, temperature, extra } = req.body;
    await query(
      `INSERT INTO metrics(device_id, heart_rate, steps, spo2, temperature, extra)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [
        req.params.deviceId,
        heart_rate ?? null,
        steps ?? null,
        spo2 ?? null,
        temperature ?? null,
        extra ? JSON.stringify(extra) : null
      ]
    );

    await query(
      'UPDATE devices SET status = ? WHERE id = ? AND owner_id = ?',
      ['linked', req.params.deviceId, req.user.id]
    );

    setState(req.user.id, {
      selectedCardId: 'heart',
      selectedIndex: 1,
      lastAction: 'Wear OS envio metricas demo'
    });

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('metrics user post error', err);
    return res.status(500).json({ error: 'Error al guardar metricas desde Wear OS' });
  }
});

// POST /api/devices/:deviceId/metrics  — el dispositivo envía métricas usando su token
router.post('/:deviceId/metrics', async (req, res) => {
  try {
    const bearerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!bearerToken) return res.status(401).json({ error: 'Token de dispositivo requerido' });

    const deviceResult = await query(
      'SELECT id, owner_id FROM devices WHERE id = ? AND token = ?',
      [req.params.deviceId, bearerToken]
    );
    if (deviceResult.rowCount === 0) {
      return res.status(401).json({ error: 'Dispositivo no autorizado' });
    }

    const { heart_rate, steps, spo2, temperature, extra } = req.body;
    await query(
      `INSERT INTO metrics(device_id, heart_rate, steps, spo2, temperature, extra)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [
        req.params.deviceId,
        heart_rate ?? null,
        steps ?? null,
        spo2 ?? null,
        temperature ?? null,
        extra ? JSON.stringify(extra) : null
      ]
    );

    setState(deviceResult.rows[0].owner_id, {
      selectedCardId: 'heart',
      selectedIndex: 1,
      lastAction: 'Wearable envio nuevas metricas'
    });

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('metrics post error', err);
    return res.status(500).json({ error: 'Error al guardar métricas' });
  }
});

// GET /api/devices/:deviceId/metrics  — últimas métricas (requiere auth de usuario)
router.get('/:deviceId/metrics', verifyToken, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    // Verificar que el dispositivo pertenece al usuario
    const devResult = await query(
      'SELECT id FROM devices WHERE id = ? AND owner_id = ?',
      [req.params.deviceId, req.user.id]
    );
    if (devResult.rowCount === 0) return res.status(404).json({ error: 'Dispositivo no encontrado' });

    const result = await query(
      `SELECT id, heart_rate, steps, spo2, temperature, extra, recorded_at
       FROM metrics WHERE device_id = ? ORDER BY recorded_at DESC LIMIT ?`,
      [req.params.deviceId, limit]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('metrics get error', err);
    return res.status(500).json({ error: 'Error al obtener métricas' });
  }
});

// GET /api/devices/:deviceId/metrics/latest  — última métrica registrada
router.get('/:deviceId/metrics/latest', verifyToken, async (req, res) => {
  try {
    const devResult = await query(
      'SELECT id FROM devices WHERE id = ? AND owner_id = ?',
      [req.params.deviceId, req.user.id]
    );
    if (devResult.rowCount === 0) return res.status(404).json({ error: 'Dispositivo no encontrado' });

    const result = await query(
      `SELECT id, heart_rate, steps, spo2, temperature, extra, recorded_at
       FROM metrics WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 1`,
      [req.params.deviceId]
    );
    if (result.rowCount === 0) return res.json(null);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('metrics latest error', err);
    return res.status(500).json({ error: 'Error al obtener última métrica' });
  }
});

module.exports = router;
