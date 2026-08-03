const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sketchbook'
};

let pool;

async function ensurePool() {
  if (pool) return pool;
  pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
  return pool;
}

async function query(text, params){
  const p = await ensurePool();
  const [rows] = await p.execute(text, params || []);

  if (Array.isArray(rows)) {
    return { rows, rowCount: rows.length };
  }

  return {
    rows: [],
    rowCount: Number(rows.affectedRows || 0),
    insertId: rows.insertId
  };
}

async function init(){
  const adminConn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password
  });

  await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await adminConn.end();

  const sql = fs.readFileSync(path.join(__dirname, 'sql', 'init.sql')).toString();
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  const p = await ensurePool();
  for (const stmt of statements) {
    await p.query(stmt);
  }
}

module.exports = { pool, query, init };
