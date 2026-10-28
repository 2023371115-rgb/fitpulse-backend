const mysql = require('mysql2/promise');
const { ensureSchema } = require('./services/schema');

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sketchbook',
  ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
};

let pool;

/** Todas las fechas se manejan en UTC; cada cliente indica su zona horaria. */
async function ensurePool() {
  if (pool) return pool;
  pool = mysql.createPool({
    ...dbConfig,
    timezone: 'Z',
    dateStrings: false,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  pool.pool.on('connection', conn => conn.query("SET time_zone = '+00:00'"));
  return pool;
}

async function query(text, params) {
  const p = await ensurePool();
  const [rows] = await p.execute(text, params || []);

  if (Array.isArray(rows)) {
    return { rows, rowCount: rows.length };
  }

  return {
    rows: [],
    rowCount: Number(rows.affectedRows || 0),
    insertId: rows.insertId,
  };
}

/** Crea la base de datos si no existe y aplica la migración. */
async function init() {
  const { database, ...serverConfig } = dbConfig;
  const adminConn = await mysql.createConnection(serverConfig);
  await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await adminConn.end();
  return migrate();
}

/** Aplica la migración sobre una base existente (no la crea). */
async function migrate() {
  const p = await ensurePool();
  return ensureSchema(p);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = {
  get pool() { return pool; },
  ensurePool,
  query,
  init,
  migrate,
  close,
};
