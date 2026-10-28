const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');

const KINDS = new Set(['goal', 'sync', 'heart', 'battery', 'session', 'tip']);

/** Crea una notificación para el usuario. Nunca rompe la petición que la origina. */
async function notify(userId, kind, title, body) {
  try {
    await query(
      'INSERT INTO notifications(id, user_id, kind, title, body) VALUES(?, ?, ?, ?, ?)',
      [uuidv4(), userId, KINDS.has(kind) ? kind : 'tip', String(title).slice(0, 120), String(body).slice(0, 500)]
    );
  } catch (err) {
    console.warn('notify skipped:', err.message);
  }
}

module.exports = { notify };
