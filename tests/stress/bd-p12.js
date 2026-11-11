#!/usr/bin/env node
/**
 * Práctica 12 · Pruebas avanzadas de base de datos (se ejecuta EN el servidor).
 *
 *   curl -fsSL <url>/tests/stress/bd-p12.js -o /tmp/bd-p12.js
 *   cd /opt/fitpulse/backend && sudo node /tmp/bd-p12.js
 *
 * Usa el mismo driver (mysql2) y las mismas credenciales que la API (lee .env de la carpeta
 * actual). Crea un usuario temporal con 50 000 sesiones y 20 000 reportes, mide las consultas
 * de la API (5 ejecuciones cada una), prueba concurrencia sobre registros distintos y sobre el
 * mismo registro, cuenta las consultas que hace una búsqueda y al final borra todo lo que creó.
 * Resultados: /tmp/bd-p12-<fecha>.json y .txt
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const from = p => require(require.resolve(p, { paths: [process.cwd()] }));
const mysql = from('mysql2/promise');
const jwt = from('jsonwebtoken');

// .env de la API
const env = {};
for (const line of fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const SESSIONS = Number(process.env.SESIONES || 50000);
const TICKETS = Number(process.env.TICKETS || 20000);
const RUNS = 5;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
const r2 = x => Math.round(x * 100) / 100;
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const FIELDS = `id, type, started_at, ended_at, distance_km, steps, calories, avg_heart_rate, max_heart_rate, notes, device_name, created_at,
  CASE WHEN ended_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(SECOND, started_at, ended_at) END AS duration_sec`;

(async () => {
  const cfg = { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, timezone: 'Z', dateStrings: false };
  const pool = mysql.createPool({ ...cfg, connectionLimit: 12 });
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];
  const status = async name => Number((await q('SHOW GLOBAL STATUS LIKE ?', [name]))[0]?.Value || 0);
  const out = { fecha: new Date().toISOString(), db: env.DB_NAME, version: (await q('SELECT VERSION() AS v'))[0].v, pruebas: [] };
  log(`FitPulse · Práctica 12 · Base de datos ${env.DB_NAME} (MariaDB ${out.version}) · ${out.fecha}`);

  const uid = 'wb-p12-' + Date.now();
  await q("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Prueba BD P12')", [uid, uid + '@fitpulse.test']);
  let t0 = performance.now();
  await q(`INSERT INTO sessions (id, user_id, type, started_at, ended_at, distance_km, steps, calories, avg_heart_rate, max_heart_rate, notes, device_name)
    SELECT UUID(), ?, ELT(1 + seq % 5, 'running','walking','cycling','gym','swimming'),
           NOW() - INTERVAL seq * 47 MINUTE, NOW() - INTERVAL seq * 47 MINUTE + INTERVAL 30 MINUTE,
           ROUND(2 + (seq % 9) * 0.8, 2), 2500 + (seq % 11) * 700, 140 + (seq % 13) * 25, 118 + seq % 30, 150 + seq % 20,
           CONCAT('sesión de carga ', seq), 'FitPulse Band'
    FROM seq_1_to_${SESSIONS}`, [uid]);
  const tIns = performance.now() - t0;
  t0 = performance.now();
  await q(`INSERT INTO tickets (id, user_id, title, description, category, severity, status, screen, platform)
    SELECT UUID(), ?, CONCAT('Reporte de carga ', seq), CONCAT('Descripción del reporte de carga número ', seq),
           ELT(1 + seq % 6, 'bug','crash','ui','performance','data','other'), ELT(1 + seq % 4, 'low','medium','high','critical'),
           ELT(1 + seq % 4, 'open','in_progress','resolved','closed'), 'Sesiones', 'script'
    FROM seq_1_to_${TICKETS}`, [uid]);
  const tInsT = performance.now() - t0;
  log(`Datos temporales: ${SESSIONS} sesiones en ${r2(tIns)} ms y ${TICKETS} reportes en ${r2(tInsT)} ms (usuario ${uid})`);
  await q('ANALYZE TABLE sessions, tickets');
  const someId = (await q('SELECT id FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 1 OFFSET 1234', [uid]))[0].id;

  async function measure(id, desc, sql, params) {
    const times = [];
    let rows = 0;
    let bytes = 0;
    for (let i = 0; i < RUNS; i++) {
      const t = performance.now();
      const r = await q(sql, params);
      times.push(performance.now() - t);
      rows = r.length;
      if (i === 0) bytes = Buffer.byteLength(JSON.stringify(r));
    }
    const plan = await q('EXPLAIN ' + sql, params);
    const an = await q('ANALYZE FORMAT=JSON ' + sql, params);
    const aj = JSON.parse(Object.values(an[0])[0]);
    const examined = [];
    JSON.stringify(aj, (k, v) => { if (k === 'r_rows' && typeof v === 'number') examined.push(v); return v; });
    const res = {
      id, desc, filas: rows, bytes, ms_mediana: r2(median(times)), ms_min: r2(Math.min(...times)), ms_max: r2(Math.max(...times)),
      ms_servidor: r2(aj.query_block?.r_total_time_ms ?? NaN), filas_examinadas: Math.round(examined.reduce((a, b) => a + b, 0)),
      plan: plan.map(p => `${p.table}: ${p.type}${p.key ? ' · ' + p.key : ''} · ${p.rows} filas${p.Extra ? ' · ' + p.Extra : ''}`).join(' | '),
    };
    out.pruebas.push(res);
    log(`${id} ${desc}\n    ${res.filas} filas · ${res.bytes} B · mediana ${res.ms_mediana} ms (mín ${res.ms_min}, máx ${res.ms_max}) · en el servidor ${res.ms_servidor} ms · examinadas ${res.filas_examinadas}\n    plan: ${res.plan}`);
    return res;
  }

  log('\n== Consultas (5 ejecuciones, tiempo desde el driver como en la API) ==');
  await measure('BD-01', 'Sesión por id (GET /api/sessions/:id)', `SELECT ${FIELDS}, hr_samples FROM sessions WHERE id = ? AND user_id = ?`, [someId, uid]);
  await measure('BD-02', 'Conjunto pequeño: últimas 20 sesiones', `SELECT ${FIELDS} FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 20`, [uid]);
  await measure('BD-03', 'Conjunto grande: las 200 que permite la API', `SELECT ${FIELDS} FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 200`, [uid]);
  await measure('BD-03b', `Conjunto muy grande: todo el historial (${SESSIONS})`, `SELECT ${FIELDS} FROM sessions WHERE user_id = ? ORDER BY started_at DESC`, [uid]);
  await measure('BD-04', 'Filtro: bicicleta de los últimos 90 días', `SELECT ${FIELDS} FROM sessions WHERE user_id = ? AND type = 'cycling' AND started_at >= NOW() - INTERVAL 90 DAY ORDER BY started_at DESC LIMIT 100`, [uid]);
  await measure('BD-04b', 'Filtro con agregación: resumen del mes (GET /api/metrics/summary)', `SELECT DATE(started_at) AS d, COUNT(*) n, SUM(steps) s, SUM(distance_km) km FROM sessions WHERE user_id = ? AND started_at >= NOW() - INTERVAL 30 DAY GROUP BY d`, [uid]);

  const hasRank = (await q("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND INDEX_NAME = 'idx_tickets_rank'"))[0].n > 0;
  log(`\n== Lista de reportes del administrador (${TICKETS + Number((await q('SELECT COUNT(*) n FROM tickets'))[0].n) - TICKETS} reportes) · índice idx_tickets_rank: ${hasRank ? 'sí' : 'no'} ==`);
  await measure('BD-05a', 'Orden original: ORDER BY FIELD(status…), FIELD(severity…)', `SELECT t.id, t.folio, t.title, t.status, t.severity, t.created_at, u.email FROM tickets t LEFT JOIN users u ON u.id = t.user_id
    ORDER BY FIELD(t.status,'open','in_progress','resolved','closed'), FIELD(t.severity,'critical','high','medium','low'), t.created_at DESC LIMIT 500`, []);
  await measure('BD-05b', 'Orden optimizado: ORDER BY status, severity DESC, created_at DESC', `SELECT t.id, t.folio, t.title, t.status, t.severity, t.created_at, u.email FROM tickets t LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.status, t.severity DESC, t.created_at DESC LIMIT 500`, []);
  const same = JSON.stringify((await q(`SELECT id FROM tickets ORDER BY FIELD(status,'open','in_progress','resolved','closed'), FIELD(severity,'critical','high','medium','low'), created_at DESC, id LIMIT 500`)).map(r => r.id))
    === JSON.stringify((await q('SELECT id FROM tickets ORDER BY status, severity DESC, created_at DESC, id LIMIT 500')).map(r => r.id));
  log(`    ¿Mismo orden en ambas consultas? ${same ? 'sí' : 'NO'}`);
  out.mismo_orden = same;

  log('\n== Concurrencia ==');
  const ids = (await q('SELECT id FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 200', [uid])).map(r => r.id);
  let w0 = await status('Innodb_row_lock_waits');
  t0 = performance.now();
  const upd = await Promise.allSettled(ids.map((id, i) => q('UPDATE sessions SET steps = ? WHERE id = ? AND user_id = ?', [9000 + i, id, uid])));
  const tUpd = performance.now() - t0;
  const after = new Map((await q('SELECT id, steps FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 200', [uid])).map(r => [r.id, Number(r.steps)]));
  const okUpd = ids.filter((id, i) => after.get(id) === 9000 + i).length;
  const c1 = { id: 'BD-06', desc: '200 actualizaciones concurrentes de registros distintos (12 conexiones)', ms: r2(tUpd), errores: upd.filter(r => r.status === 'rejected').length, verificadas: Number(okUpd), esperas_bloqueo: (await status('Innodb_row_lock_waits')) - w0 };
  out.pruebas.push(c1);
  log(`BD-06 ${c1.desc}: ${c1.ms} ms · ${c1.errores} errores · ${c1.verificadas}/200 con su valor · ${c1.esperas_bloqueo} esperas por bloqueo`);

  const target = ids[0];
  async function sameRow(id, desc, fn) {
    await q('UPDATE sessions SET steps = 0 WHERE id = ?', [target]);
    const waits0 = await status('Innodb_row_lock_waits');
    const time0 = await status('Innodb_row_lock_time');
    const t = performance.now();
    const rs = await Promise.allSettled(Array.from({ length: 50 }, () => fn()));
    const ms = performance.now() - t;
    const final = Number((await q('SELECT steps FROM sessions WHERE id = ?', [target]))[0].steps);
    const r = { id, desc, ms: r2(ms), final, esperado: 50, perdidas: 50 - final, errores: rs.filter(x => x.status === 'rejected').length,
      esperas_bloqueo: (await status('Innodb_row_lock_waits')) - waits0, ms_en_bloqueo: (await status('Innodb_row_lock_time')) - time0 };
    out.pruebas.push(r);
    log(`${id} ${desc}: valor final ${final}/50 · ${r.perdidas} actualizaciones perdidas · ${r.errores} errores · ${r.esperas_bloqueo} esperas (${r.ms_en_bloqueo} ms) · ${r.ms} ms`);
  }
  await sameRow('BD-07a', '50 escrituras simultáneas "leer y luego escribir"', async () => {
    const [[row]] = await pool.query('SELECT steps FROM sessions WHERE id = ?', [target]);
    await new Promise(r => setTimeout(r, 5));
    await pool.query('UPDATE sessions SET steps = ? WHERE id = ?', [Number(row.steps) + 1, target]);
  });
  await sameRow('BD-07b', '50 escrituras simultáneas atómicas (steps = steps + 1)', () => pool.query('UPDATE sessions SET steps = steps + 1 WHERE id = ?', [target]));
  await sameRow('BD-07c', '50 escrituras simultáneas con transacción y SELECT … FOR UPDATE', async () => {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[row]] = await c.query('SELECT steps FROM sessions WHERE id = ? FOR UPDATE', [target]);
      await c.query('UPDATE sessions SET steps = ? WHERE id = ?', [Number(row.steps) + 1, target]);
      await c.commit();
    } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  });

  // Consultas que hace una búsqueda (GET /api/search) y su tiempo, llamando a la API local
  log('\n== Consultas repetidas: GET /api/search contra la API local ==');
  const token = jwt.sign({ sub: uid, email: uid + '@fitpulse.test' }, env.JWT_SECRET, { expiresIn: '10m' });
  const port = Number(env.PORT || 3000);
  const call = () => new Promise(resolve => {
    const t = performance.now();
    http.get({ host: '127.0.0.1', port, path: '/api/search?q=carga', headers: { Authorization: 'Bearer ' + token } }, res => {
      let n = 0; res.on('data', c => { n += c.length; }); res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - t, bytes: n }));
    }).on('error', e => resolve({ status: 0, ms: 0, error: e.message }));
  });
  const searches = [];
  for (let i = 0; i < 5; i++) {
    const s0 = await status('Com_select');
    const r = await call();
    searches.push({ ...r, selects: (await status('Com_select')) - s0 - 1 });
  }
  const sr = { id: 'BD-08', desc: 'SELECT por cada búsqueda (5 búsquedas seguidas)', selects: searches.map(s => s.selects), ms: searches.map(s => r2(s.ms)), status: searches.map(s => s.status) };
  out.pruebas.push(sr);
  log(`BD-08 ${sr.desc}: SELECT ${sr.selects.join(', ')} · ms ${sr.ms.join(', ')} · HTTP ${sr.status.join(', ')}`);

  // Integridad y limpieza
  const integ = {
    sesiones: Number((await q('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', [uid]))[0].n),
    huerfanas: Number((await q('SELECT COUNT(*) n FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL'))[0].n),
    fin_antes_inicio: Number((await q('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND ended_at < started_at', [uid]))[0].n),
  };
  out.integridad = integ;
  log(`\nIntegridad: ${integ.sesiones}/${SESSIONS} sesiones · ${integ.huerfanas} sin usuario · ${integ.fin_antes_inicio} con fin antes del inicio`);
  await q('DELETE FROM tickets WHERE user_id = ?', [uid]);
  await q('DELETE FROM users WHERE id = ?', [uid]);
  await q('ALTER TABLE tickets AUTO_INCREMENT = 1');
  log(`Limpieza: usuario temporal, sus sesiones (CASCADE) y sus reportes eliminados · restantes ${(await q("SELECT COUNT(*) n FROM users WHERE id LIKE 'wb-p12-%'"))[0].n}`);
  await pool.end();
  const base = `/tmp/bd-p12-${stamp}`;
  fs.writeFileSync(base + '.json', JSON.stringify(out, null, 2));
  fs.writeFileSync(base + '.txt', lines.join('\n') + '\n');
  log(`Resultados: ${base}.json y ${base}.txt`);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
