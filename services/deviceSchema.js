const { query } = require('../db');

let pairingColumnsReady = false;

async function ensurePairingColumns() {
  if (pairingColumnsReady) return;

  try {
    await query('ALTER TABLE devices ADD COLUMN pair_code VARCHAR(12) NULL');
  } catch (err) {
    if (!err || err.code !== 'ER_DUP_FIELDNAME') {
      throw err;
    }
  }

  try {
    await query('ALTER TABLE devices ADD COLUMN pair_code_expires_at DATETIME NULL');
  } catch (err) {
    if (!err || err.code !== 'ER_DUP_FIELDNAME') {
      throw err;
    }
  }

  pairingColumnsReady = true;
}

module.exports = { ensurePairingColumns };
