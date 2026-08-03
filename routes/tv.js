const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { getState, setState, subscribe } = require('../services/tvSync');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

const allowedCardIds = new Set(['steps', 'heart', 'sessions', 'devices']);

function authFromQuery(req, res, next) {
  const token = (req.query.token || '').toString();
  if (!token) return res.status(401).json({ error: 'token requerido' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'token invalido' });
  }
}

async function buildTvPayload(userId) {
  const summaryResult = await query(
    `SELECT
       COUNT(*) AS total_sessions,
       COALESCE(SUM(steps), 0) AS total_steps,
       COALESCE(SUM(calories), 0) AS total_calories,
       COALESCE(AVG(avg_heart_rate), 0) AS avg_heart_rate,
       COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 0 ELSE TIMESTAMPDIFF(MINUTE, started_at, ended_at) END), 0) AS total_minutes
     FROM sessions
     WHERE user_id = ? AND started_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    [userId]
  );

  const deviceResult = await query(
    `SELECT d.id, d.name, d.type, d.status, m.heart_rate, m.steps, m.spo2, m.temperature, m.recorded_at
     FROM devices d
     LEFT JOIN metrics m ON m.id = (
       SELECT mx.id FROM metrics mx WHERE mx.device_id = d.id ORDER BY mx.recorded_at DESC LIMIT 1
     )
     WHERE d.owner_id = ?
     ORDER BY d.created_at DESC
     LIMIT 4`,
    [userId]
  );

  const summary = summaryResult.rows[0] || {};
  const devices = deviceResult.rows || [];
  const latestMetric = devices.find(d => d.heart_rate || d.steps || d.spo2 || d.temperature) || {};
  const state = getState(userId);

  return {
    state,
    cards: [
      {
        id: 'steps',
        label: 'Pasos',
        value: Number(summary.total_steps || latestMetric.steps || 0).toLocaleString('es-MX'),
        detail: `${summary.total_minutes || 0} min activos esta semana`,
        media: 'steps',
        fields: [
          { label: 'Sesiones', value: String(summary.total_sessions || 0) },
          { label: 'Calorias', value: `${Math.round(summary.total_calories || 0)} kcal` },
          { label: 'Meta', value: '10,000 pasos' }
        ]
      },
      {
        id: 'heart',
        label: 'Ritmo cardiaco',
        value: `${Math.round(latestMetric.heart_rate || summary.avg_heart_rate || 0)} lpm`,
        detail: latestMetric.recorded_at ? `Actualizado ${new Date(latestMetric.recorded_at).toLocaleTimeString('es-MX')}` : 'Esperando wearable',
        media: 'heart',
        fields: [
          { label: 'SpO2', value: latestMetric.spo2 ? `${latestMetric.spo2}%` : 'Sin dato' },
          { label: 'Temp', value: latestMetric.temperature ? `${latestMetric.temperature} C` : 'Sin dato' },
          { label: 'Fuente', value: latestMetric.name || 'API' }
        ]
      },
      {
        id: 'sessions',
        label: 'Entrenamientos',
        value: String(summary.total_sessions || 0),
        detail: 'Sesiones registradas en los ultimos 7 dias',
        media: 'sessions',
        fields: [
          { label: 'Duracion', value: `${summary.total_minutes || 0} min` },
          { label: 'FC media', value: `${Math.round(summary.avg_heart_rate || 0)} lpm` },
          { label: 'Calorias', value: `${Math.round(summary.total_calories || 0)} kcal` }
        ]
      },
      {
        id: 'devices',
        label: 'Dispositivos',
        value: String(devices.length),
        detail: `${devices.filter(d => d.status === 'linked').length} enlazados ahora`,
        media: 'devices',
        fields: [
          { label: 'Telefono', value: devices.some(d => d.type === 'phone') ? 'Activo' : 'Pendiente' },
          { label: 'Wearable', value: devices.some(d => d.type === 'wearable') ? 'Activo' : 'Pendiente' },
          { label: 'Smart TV', value: devices.some(d => d.type === 'smarttv') ? 'Activo' : 'Pendiente' }
        ]
      }
    ]
  };
}

router.get('/state', authMiddleware, async (req, res) => {
  try {
    return res.json(await buildTvPayload(req.user.id));
  } catch (err) {
    console.error('tv state error', err);
    return res.status(500).json({ error: 'Error al obtener estado TV' });
  }
});

router.post('/state', authMiddleware, async (req, res) => {
  const selectedCardId = allowedCardIds.has(req.body.selectedCardId) ? req.body.selectedCardId : undefined;
  const selectedIndex = Number.isInteger(req.body.selectedIndex)
    ? Math.max(0, Math.min(3, req.body.selectedIndex))
    : undefined;
  const lastAction = typeof req.body.lastAction === 'string'
    ? req.body.lastAction.slice(0, 140)
    : 'Accion desde telefono';

  const next = setState(req.user.id, {
    ...(selectedCardId ? { selectedCardId } : {}),
    ...(selectedIndex !== undefined ? { selectedIndex } : {}),
    lastAction
  });

  return res.json(next);
});

router.get('/events', authFromQuery, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = async (state) => {
    try {
      const payload = await buildTvPayload(req.user.id);
      payload.state = state || payload.state;
      res.write(`event: tv-state\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      res.write(`event: tv-error\n`);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };

  await send(getState(req.user.id));
  const ping = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 25000);
  const unsubscribe = subscribe(req.user.id, send);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

module.exports = { router, buildTvPayload };
