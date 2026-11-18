/**
 * Prácticas 13 y 14 · Automatización: integración API ↔ base de datos y persistencia.
 *
 *   AUT-05  la API devuelve el código HTTP esperado en cada caso
 *   AUT-06  lo que la API acepta queda almacenado en MariaDB tal como se espera
 *           (y lo que rechaza no deja rastro)
 *
 *   node --test --test-concurrency=1 tests/p13.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_NAME = process.env.P13_DB_NAME || 'fitpulse_p13t';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

const mysql = require('mysql2/promise');
const db = require('../db');
const app = require('../server');

let server;
let base;

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const row = async (sql, params) => (await db.query(sql, params)).rows[0];
let n = 0;
const ip = () => ({ 'X-Forwarded-For': `10.13.0.${++n}` });

test.before(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${process.env.DB_NAME}\``);
  await conn.end();
  await db.init();
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
});

test('AUT-06 registro: guarda el usuario con la contraseña cifrada (bcrypt), nunca en claro', async () => {
  const email = `Persist.${Date.now()}@FitPulse.test`;
  const r = await api('POST', '/api/auth/register', { body: { email, password: 'clave-segura-1', name: '  Ana López  ' }, headers: ip() });
  assert.equal(r.status, 201);
  const u = await row('SELECT email, name, password_hash, role, active FROM users WHERE id = ?', [r.body.user.id]);
  assert.equal(u.email, email.toLowerCase(), 'correo normalizado');
  assert.equal(u.name, 'Ana López', 'nombre sin espacios sobrantes');
  assert.match(u.password_hash, /^\$2[aby]\$\d{2}\$.{53}$/, 'hash bcrypt');
  assert.ok(!u.password_hash.includes('clave-segura-1'));
  assert.equal(u.role, 'user');
  assert.equal(Number(u.active), 1);
});

test('AUT-06 registro rechazado (400 / 409) no deja filas en la base', async () => {
  const before = Number((await row('SELECT COUNT(*) n FROM users')).n);
  assert.equal((await api('POST', '/api/auth/register', { body: { email: 'corto@fitpulse.test', password: '1234567' }, headers: ip() })).status, 400);
  assert.equal((await api('POST', '/api/auth/register', { body: { email: 'no-es-correo', password: 'clave-segura-1' }, headers: ip() })).status, 400);
  const email = `dup.${Date.now()}@fitpulse.test`;
  assert.equal((await api('POST', '/api/auth/register', { body: { email, password: 'clave-segura-1' }, headers: ip() })).status, 201);
  const dup = await api('POST', '/api/auth/register', { body: { email: email.toUpperCase(), password: 'clave-segura-1' }, headers: ip() });
  assert.equal(dup.status, 409, 'el mismo correo en mayúsculas también es duplicado');
  assert.equal(Number((await row('SELECT COUNT(*) n FROM users')).n), before + 1);
});

test('AUT-06 una sesión registrada se almacena con sus valores y sus lecturas de ritmo cardíaco', async () => {
  const reg = await api('POST', '/api/auth/register', { body: { email: `ses.${Date.now()}@fitpulse.test`, password: 'clave-segura-1' }, headers: ip() });
  const token = reg.body.token;
  const started = new Date(Date.now() - 3600e3).toISOString();
  const c = await api('POST', '/api/sessions', { token, body: { type: 'running', started_at: started, duration_sec: 1800, distance_km: 5.25, steps: 6400, calories: 310, hr_samples: [120, 130, 140] } });
  assert.equal(c.status, 201);
  const s = await row('SELECT user_id, type, distance_km, steps, calories, TIMESTAMPDIFF(SECOND, started_at, ended_at) AS secs FROM sessions WHERE id = ?', [c.body.id]);
  assert.equal(s.user_id, reg.body.user.id);
  assert.equal(s.type, 'running');
  assert.equal(Number(s.distance_km), 5.25);
  assert.equal(Number(s.steps), 6400);
  assert.equal(Number(s.secs), 1800, 'ended_at = started_at + duración');
  const detail = await api('GET', '/api/sessions/' + c.body.id, { token });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.hr_samples.map(Number), [120, 130, 140]);
});

test('AUT-05 códigos HTTP esperados de la API', async () => {
  const reg = await api('POST', '/api/auth/register', { body: { email: `cod.${Date.now()}@fitpulse.test`, password: 'clave-segura-1' }, headers: ip() });
  const token = reg.body.token;
  const cases = [
    ['GET /api/health', await api('GET', '/api/health'), 200],
    ['GET /api/sessions sin token', await api('GET', '/api/sessions'), 401],
    ['GET /api/sessions con token falso', await api('GET', '/api/sessions', { token: 'x.y.z' }), 401],
    ['GET /api/sessions?limit=5.5 (regresión D-01)', await api('GET', '/api/sessions?limit=5.5', { token }), 200],
    ['GET /api/sessions/inexistente', await api('GET', '/api/sessions/00000000-0000-0000-0000-000000000000', { token }), 404],
    ['POST /api/sessions con tipo inválido', await api('POST', '/api/sessions', { token, body: { type: 'volar', duration_sec: 60 } }), 400],
    ['GET /api/admin/users como usuario normal', await api('GET', '/api/admin/users', { token }), 403],
    ['GET /api/ruta-que-no-existe', await api('GET', '/api/ruta-que-no-existe', { token }), 404],
    ['POST /api/auth/login contraseña incorrecta', await api('POST', '/api/auth/login', { body: { email: 'nadie@fitpulse.test', password: 'xxxxxxxx' }, headers: ip() }), 401],
    ['POST /api/workspaces/../files (regresión D-02)', await api('POST', '/api/workspaces/..%2F..%2Fx/files', { token }), 400],
  ];
  const wrong = cases.filter(([, r, expected]) => r.status !== expected).map(([name, r, expected]) => `${name}: esperado ${expected}, recibido ${r.status}`);
  assert.deepEqual(wrong, []);
});
