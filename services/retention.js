const { query } = require('../db');

/**
 * Retención de datos de salud:
 * - Lecturas crudas del wearable (metrics): 30 días.
 * - Sesiones de actividad: 365 días, para que el usuario pueda consultar su historial
 *   y las métricas mensuales (antes se borraban a los 30 días).
 */
const METRICS_DAYS = 30;
const SESSIONS_DAYS = 365;

async function purgeOldHealthData() {
  const metrics = await query(
    `DELETE FROM metrics WHERE recorded_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${METRICS_DAYS} DAY)`
  );
  const sessions = await query(
    `DELETE FROM sessions WHERE started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${SESSIONS_DAYS} DAY)`
  );
  return {
    metricsDeleted: metrics.rowCount,
    sessionsDeleted: sessions.rowCount
  };
}

function startRetentionJob() {
  purgeOldHealthData()
    .then(result => console.log('Retention cleanup complete', result))
    .catch(err => console.warn('Retention cleanup skipped:', err.message));

  setInterval(() => {
    purgeOldHealthData()
      .then(result => console.log('Retention cleanup complete', result))
      .catch(err => console.warn('Retention cleanup skipped:', err.message));
  }, 24 * 60 * 60 * 1000);
}

module.exports = { purgeOldHealthData, startRetentionJob, METRICS_DAYS, SESSIONS_DAYS };
