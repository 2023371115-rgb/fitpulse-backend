const { query } = require('../db');
const { periodWindow } = require('./time');

/** Tipos cuyo avance se calcula a partir de sesiones y métricas. */
const AUTO_TYPES = new Set(['steps', 'distance', 'workouts', 'calories', 'active']);

/**
 * Valor acumulado de un tipo de meta para un usuario en la ventana [from, to).
 * - steps:    pasos de sesiones + pasos enviados por sus dispositivos
 * - distance: km de sesiones
 * - workouts: número de sesiones
 * - calories: kcal de sesiones
 * - active:   minutos de sesiones
 */
async function valueFor(userId, type, from, to) {
  if (type === 'steps') {
    const r = await query(
      `SELECT
         (SELECT COALESCE(SUM(steps), 0) FROM sessions
           WHERE user_id = ? AND started_at >= ? AND started_at < ?) +
         (SELECT COALESCE(SUM(m.steps), 0) FROM metrics m JOIN devices d ON d.id = m.device_id
           WHERE d.owner_id = ? AND m.recorded_at >= ? AND m.recorded_at < ?) AS value`,
      [userId, from, to, userId, from, to]
    );
    return Number(r.rows[0].value || 0);
  }

  const expr = {
    distance: 'COALESCE(SUM(distance_km), 0)',
    workouts: 'COUNT(*)',
    calories: 'COALESCE(SUM(calories), 0)',
    active: 'COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 0 ELSE TIMESTAMPDIFF(MINUTE, started_at, ended_at) END), 0)',
  }[type];
  if (!expr) return 0;

  const r = await query(
    `SELECT ${expr} AS value FROM sessions WHERE user_id = ? AND started_at >= ? AND started_at < ?`,
    [userId, from, to]
  );
  return Number(r.rows[0].value || 0);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Agrega a cada meta su avance: current, progress (0..1), done e history
 * (avance de los últimos 7 días o semanas, del más antiguo al actual).
 */
async function withProgress(userId, goals, offsetMin, now = new Date(), { history = true } = {}) {
  const result = [];
  for (const g of goals) {
    const period = g.period === 'weekly' ? 'weekly' : 'daily';
    const target = Number(g.target);
    let current;
    let hist = [];

    if (AUTO_TYPES.has(g.type)) {
      const { from, to } = periodWindow(period, now, offsetMin);
      current = await valueFor(userId, g.type, from, to);
      if (history) {
        for (let back = 6; back >= 1; back--) {
          const w = periodWindow(period, now, offsetMin, back);
          const v = await valueFor(userId, g.type, w.from, w.to);
          hist.push(target > 0 ? round(Math.min(v / target, 1)) : 0);
        }
      }
    } else {
      current = Number(g.manual_value || 0);
    }

    const progress = target > 0 ? Math.min(current / target, 1) : 0;
    if (history && hist.length) hist.push(round(progress));

    result.push({
      ...g,
      target,
      manual_value: g.manual_value === null || g.manual_value === undefined ? null : Number(g.manual_value),
      period,
      auto: AUTO_TYPES.has(g.type),
      current: round(current),
      progress: round(progress),
      done: target > 0 && current >= target,
      history: hist,
    });
  }
  return result;
}

async function activeGoals(userId) {
  const r = await query(
    `SELECT id, type, title, target, unit, period, manual_value, active, created_at
     FROM goals WHERE user_id = ? AND active = 1`,
    [userId]
  );
  return r.rows;
}

module.exports = { AUTO_TYPES, valueFor, withProgress, activeGoals };
