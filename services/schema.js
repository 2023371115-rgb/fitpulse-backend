const fs = require('fs');
const path = require('path');

/**
 * Migración idempotente del esquema.
 * 1) Crea las tablas que no existan (sql/init.sql).
 * 2) En bases creadas con versiones anteriores agrega columnas, valores de ENUM
 *    e índices nuevos sin borrar datos. Se puede ejecutar cuantas veces sea.
 */

const COLUMNS = [
  ['users', 'avatar', 'MEDIUMTEXT NULL'],
  ['users', 'active', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ['users', 'role', "VARCHAR(20) NOT NULL DEFAULT 'user'"],
  ['users', 'weight_kg', 'DECIMAL(5,1) NULL'],
  ['users', 'height_cm', 'SMALLINT UNSIGNED NULL'],
  ['users', 'age', 'TINYINT UNSIGNED NULL'],
  ['users', 'daily_step_goal', 'INT UNSIGNED NOT NULL DEFAULT 10000'],
  ['devices', 'pair_code', 'VARCHAR(12) NULL'],
  ['devices', 'pair_code_expires_at', 'DATETIME NULL'],
  ['devices', 'battery', 'TINYINT UNSIGNED NULL'],
  ['devices', 'last_sync_at', 'DATETIME NULL'],
  ['goals', 'title', 'VARCHAR(120) NULL'],
  ['goals', 'period', "ENUM('daily','weekly') NOT NULL DEFAULT 'daily'"],
  ['goals', 'manual_value', 'DECIMAL(10,2) NULL'],
  ['sessions', 'distance_km', 'DECIMAL(6,2) NULL'],
  ['sessions', 'max_heart_rate', 'SMALLINT UNSIGNED NULL'],
  ['sessions', 'hr_samples', 'JSON NULL'],
  ['sessions', 'device_name', 'VARCHAR(120) NULL'],
];

const ENUMS = [
  ['goals', 'type', ['steps', 'calories', 'heart_rate', 'weight', 'sleep', 'distance', 'workouts', 'active'], "NOT NULL"],
];

const INDEXES = [
  ['files', 'idx_files_workspace_created', '(workspace_id, created_at)'],
  ['devices', 'idx_devices_token', '(token)', true],
  ['metrics', 'idx_metrics_device_time', '(device_id, recorded_at)'],
  ['goals', 'idx_goals_user_created', '(user_id, created_at)'],
  ['sessions', 'idx_sessions_user_started', '(user_id, started_at)'],
];

function splitStatements(sql) {
  return sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

async function columnInfo(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0] || null;
}

async function indexExists(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, index]
  );
  return rows.length > 0;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<string[]>} lista de cambios aplicados
 */
async function ensureSchema(pool) {
  const applied = [];
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'init.sql'), 'utf8');
  for (const stmt of splitStatements(sql)) {
    await pool.query(stmt);
  }

  for (const [table, column, definition] of COLUMNS) {
    if (!(await columnInfo(pool, table, column))) {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      applied.push(`${table}.${column}`);

      // Al crear la columna de roles, las cuentas "superadmin" que ya existían
      // conservan su acceso. A partir de aquí el rol solo se asigna desde la BD.
      if (table === 'users' && column === 'role') {
        await pool.query("UPDATE users SET role = 'admin' WHERE LOWER(TRIM(name)) = 'superadmin'");
      }
    }
  }

  for (const [table, column, values, extra] of ENUMS) {
    const info = await columnInfo(pool, table, column);
    if (!info) continue;
    const missing = values.filter(v => !info.type.includes(`'${v}'`));
    if (missing.length) {
      const current = info.type.match(/'([^']*)'/g).map(v => v.slice(1, -1));
      const merged = [...current, ...missing];
      await pool.query(
        `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ENUM(${merged.map(v => `'${v}'`).join(',')}) ${extra}`
      );
      applied.push(`${table}.${column} += ${missing.join(',')}`);
    }
  }

  for (const [table, index, cols, unique] of INDEXES) {
    if (!(await indexExists(pool, table, index))) {
      await pool.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${index}\` ON \`${table}\` ${cols}`);
      applied.push(`index ${index}`);
    }
  }

  return applied;
}

module.exports = { ensureSchema, splitStatements };
