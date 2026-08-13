const { query } = require('../db');

let adminColumnsReady = false;

async function ensureAdminColumns() {
  if (adminColumnsReady) return;

  try {
    await query('ALTER TABLE users ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1');
  } catch (err) {
    if (!err || err.code !== 'ER_DUP_FIELDNAME') {
      throw err;
    }
  }

  adminColumnsReady = true;
}

module.exports = { ensureAdminColumns };
