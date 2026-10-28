const express = require('express');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { DAY_MS, tzOffset, startOfLocalDay, localDateKey } = require('../services/time');
const { sendError } = require('../services/validate');

const router = express.Router();
const TYPES = ['running', 'walking', 'cycling', 'gym', 'swimming', 'other'];

function avg(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

/**
 * GET /api/metrics/summary?range=week|month
 * Resumen para las pantallas de Inicio y Métricas de la app:
 *  - today: pasos, km, kcal, minutos activos y ritmo cardíaco actual
 *  - days: valores por día local (pasos, km, kcal, minutos, sesiones)
 *  - totals y by_type del periodo
 *  - resting_hr: ritmo en reposo (mínimo diario de las lecturas del wearable)
 *  - hr_today: ritmo cardíaco promedio por hora de hoy
 */
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const offset = tzOffset(req);
    const now = new Date();
    const numDays = req.query.range === 'month' ? 30 : 7;
    const todayStart = startOfLocalDay(now, offset);
    const from = new Date(todayStart.getTime() - (numDays - 1) * DAY_MS);
    const to = new Date(todayStart.getTime() + DAY_MS);
    const shift = offset; // minutos para convertir UTC → día local en SQL

    // Días vacíos del periodo
    const days = [];
    const byKey = {};
    for (let i = 0; i < numDays; i++) {
      const d = new Date(from.getTime() + i * DAY_MS);
      const key = localDateKey(d, offset);
      const row = { date: key, steps: 0, km: 0, kcal: 0, minutes: 0, sessions: 0 };
      days.push(row);
      byKey[key] = row;
    }

    const sess = await query(
      `SELECT DATE_FORMAT(DATE_ADD(started_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS day,
              COUNT(*) AS sessions,
              COALESCE(SUM(steps), 0) AS steps,
              COALESCE(SUM(distance_km), 0) AS km,
              COALESCE(SUM(calories), 0) AS kcal,
              COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 0 ELSE TIMESTAMPDIFF(MINUTE, started_at, ended_at) END), 0) AS minutes
       FROM sessions WHERE user_id = ? AND started_at >= ? AND started_at < ?
       GROUP BY day`,
      [shift, userId, from, to]
    );
    for (const r of sess.rows) {
      const row = byKey[r.day];
      if (!row) continue;
      row.sessions += Number(r.sessions);
      row.steps += Number(r.steps);
      row.km += Number(r.km);
      row.kcal += Number(r.kcal);
      row.minutes += Number(r.minutes);
    }

    const met = await query(
      `SELECT DATE_FORMAT(DATE_ADD(m.recorded_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS day,
              COALESCE(SUM(m.steps), 0) AS steps
       FROM metrics m JOIN devices d ON d.id = m.device_id
       WHERE d.owner_id = ? AND m.recorded_at >= ? AND m.recorded_at < ?
       GROUP BY day`,
      [shift, userId, from, to]
    );
    for (const r of met.rows) {
      if (byKey[r.day]) byKey[r.day].steps += Number(r.steps);
    }
    for (const d of days) d.km = Math.round(d.km * 100) / 100;

    const totals = days.reduce(
      (t, d) => ({
        steps: t.steps + d.steps,
        km: Math.round((t.km + d.km) * 100) / 100,
        kcal: t.kcal + d.kcal,
        minutes: t.minutes + d.minutes,
        sessions: t.sessions + d.sessions,
      }),
      { steps: 0, km: 0, kcal: 0, minutes: 0, sessions: 0 }
    );

    // Tiempo y distancia por tipo de actividad
    const typeRows = await query(
      `SELECT type, COUNT(*) AS count,
              COALESCE(SUM(distance_km), 0) AS km,
              COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 0 ELSE TIMESTAMPDIFF(MINUTE, started_at, ended_at) END), 0) AS minutes
       FROM sessions WHERE user_id = ? AND started_at >= ? AND started_at < ? GROUP BY type`,
      [userId, from, to]
    );
    const byType = {};
    for (const t of TYPES) byType[t] = { count: 0, minutes: 0, km: 0 };
    for (const r of typeRows.rows) {
      byType[r.type] = { count: Number(r.count), minutes: Number(r.minutes), km: Math.round(Number(r.km) * 100) / 100 };
    }

    // Ritmo cardíaco en reposo: mínimo diario de las lecturas (14 días)
    const hrFrom = new Date(todayStart.getTime() - 13 * DAY_MS);
    const rest = await query(
      `SELECT DATE_FORMAT(DATE_ADD(m.recorded_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS day, MIN(m.heart_rate) AS hr
       FROM metrics m JOIN devices d ON d.id = m.device_id
       WHERE d.owner_id = ? AND m.heart_rate IS NOT NULL AND m.recorded_at >= ? AND m.recorded_at < ?
       GROUP BY day ORDER BY day`,
      [shift, userId, hrFrom, to]
    );
    const restMap = Object.fromEntries(rest.rows.map(r => [r.day, Number(r.hr)]));
    const trend = [];
    for (let i = 0; i < 14; i++) {
      const key = localDateKey(new Date(hrFrom.getTime() + i * DAY_MS), offset);
      if (restMap[key] !== undefined) trend.push(restMap[key]);
    }
    const last7 = trend.slice(-7);
    const prev7 = trend.slice(-14, -7);
    const restingHr = {
      current: trend.length ? trend[trend.length - 1] : null,
      delta: last7.length && prev7.length ? Math.round(avg(last7) - avg(prev7)) : null,
      trend,
    };

    // Ritmo cardíaco de hoy por hora
    const hourly = await query(
      `SELECT HOUR(DATE_ADD(m.recorded_at, INTERVAL ? MINUTE)) AS hour, ROUND(AVG(m.heart_rate)) AS bpm
       FROM metrics m JOIN devices d ON d.id = m.device_id
       WHERE d.owner_id = ? AND m.heart_rate IS NOT NULL AND m.recorded_at >= ? AND m.recorded_at < ?
       GROUP BY hour ORDER BY hour`,
      [shift, userId, todayStart, to]
    );
    const hrToday = hourly.rows.map(r => ({ hour: Number(r.hour), bpm: Number(r.bpm) }));

    // Ritmo actual: última lectura del día, o promedio de la última sesión de hoy
    const lastHr = await query(
      `SELECT m.heart_rate FROM metrics m JOIN devices d ON d.id = m.device_id
       WHERE d.owner_id = ? AND m.heart_rate IS NOT NULL AND m.recorded_at >= ?
       ORDER BY m.recorded_at DESC, m.id DESC LIMIT 1`,
      [userId, todayStart]
    );
    let heartRate = lastHr.rowCount ? Number(lastHr.rows[0].heart_rate) : null;
    if (heartRate === null) {
      const s = await query(
        `SELECT avg_heart_rate FROM sessions WHERE user_id = ? AND started_at >= ? AND avg_heart_rate IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
        [userId, todayStart]
      );
      heartRate = s.rowCount ? Number(s.rows[0].avg_heart_rate) : null;
    }

    const today = days[days.length - 1];
    return res.json({
      range: numDays === 30 ? 'month' : 'week',
      today: {
        date: today.date,
        steps: today.steps,
        km: today.km,
        kcal: today.kcal,
        active_minutes: today.minutes,
        heart_rate: heartRate,
      },
      days,
      totals,
      by_type: byType,
      resting_hr: restingHr,
      hr_today: hrToday,
    });
  } catch (err) {
    return sendError(res, err, 'Error al obtener metricas', 'metrics summary error');
  }
});

module.exports = router;
