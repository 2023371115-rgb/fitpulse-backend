const { query } = require('../db');

async function purgeOldHealthData() {
  const metrics = await query(
    'DELETE FROM metrics WHERE recorded_at < DATE_SUB(NOW(), INTERVAL 30 DAY)'
  );
  const sessions = await query(
    'DELETE FROM sessions WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)'
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

module.exports = { purgeOldHealthData, startRetentionJob };
