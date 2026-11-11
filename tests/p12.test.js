/**
 * Práctica 12 · Pruebas de las optimizaciones y de la resiliencia del backend.
 *
 *   OPT-1  Caché del índice de búsqueda: acierta, y se invalida al escribir (sin datos viejos).
 *   OPT-2  Lista de reportes del administrador: el orden nuevo (índice) es idéntico al de FIELD().
 *   RES-07 Idempotencia: la misma Idempotency-Key no crea duplicados, ni en secuencia ni en paralelo.
 *   DEF    Límite de login por IP real (trust proxy) y token con sub numérico.
 *
 *   node --test --test-concurrency=1 tests/p12.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_NAME = process.env.P12_DB_NAME || 'fitpulse_p12t';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const db = require('../db');
const app = require('../server');
const searchCache = require('../services/searchCache');

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
  return { status: res.status, body: json, headers: res.headers };
}

let n = 0;
async function register() {
  const email = `p12.${Date.now()}.${n++}@fitpulse.test`;
  const r = await api('POST', '/api/auth/register', { body: { email, password: 'password123', name: 'Prueba P12' }, headers: { 'X-Forwarded-For': `10.12.0.${n}` } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.id };
}

const session = (notes, minutesAgo = 30) => ({
  type: 'running', started_at: new Date(Date.now() - minutesAgo * 60000).toISOString(), duration_sec: 1800,
  distance_km: 5, steps: 6000, calories: 300, notes,
});
const ticket = title => ({ title, description: 'La lista tarda en cargar con muchos datos', category: 'performance', severity: 'high', screen: 'Sesiones', platform: 'android' });
const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].n);

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

test('OPT-1 caché de búsqueda', async t => {
  const u = await register();
  await api('POST', '/api/sessions', { token: u.token, body: session('trote junto al lago') });

  await t.test('la segunda búsqueda reutiliza el índice (acierto de caché)', async () => {
    const h0 = searchCache.stats.hits;
    const a = await api('GET', '/api/search?q=lago', { token: u.token });
    const b = await api('GET', '/api/search?q=lago', { token: u.token });
    assert.equal(a.status, 200);
    assert.deepEqual(b.body.hits, a.body.hits);
    assert.equal(searchCache.stats.hits - h0, 1);
  });

  await t.test('una sesión nueva aparece en la búsqueda inmediatamente (el caché se invalida)', async () => {
    const before = await api('GET', '/api/search?q=volcan', { token: u.token });
    assert.equal(before.body.hits.total, 0);
    const c = await api('POST', '/api/sessions', { token: u.token, body: session('subida al volcan', 10) });
    assert.equal(c.status, 201);
    const after = await api('GET', '/api/search?q=volcan', { token: u.token });
    assert.equal(after.body.hits.total, 1);
    await api('DELETE', '/api/sessions/' + c.body.id, { token: u.token });
    const gone = await api('GET', '/api/search?q=volcan', { token: u.token });
    assert.equal(gone.body.hits.total, 0, 'al borrar también se invalida');
  });

  await t.test('el índice de un usuario no se comparte con otro', async () => {
    const other = await register();
    const r = await api('GET', '/api/search?q=lago', { token: other.token });
    assert.equal(r.body.hits.total, 0);
  });

  await t.test('un reporte nuevo invalida también el índice de los administradores', async () => {
    const admin = await register();
    await db.query("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    const q = '/api/search?q=' + encodeURIComponent('cromatico');
    assert.equal((await api('GET', q, { token: admin.token })).body.hits.total, 0);
    await api('POST', '/api/tickets', { token: u.token, body: ticket('Error cromatico en la gráfica') });
    assert.equal((await api('GET', q, { token: admin.token })).body.hits.total, 1);
  });

  await t.test('búsquedas simultáneas sin caché construyen el índice una sola vez', async () => {
    searchCache.clear();
    const m0 = searchCache.stats.misses;
    const rs = await Promise.all(Array.from({ length: 10 }, () => api('GET', '/api/search?q=lago', { token: u.token })));
    assert.ok(rs.every(r => r.status === 200));
    assert.equal(searchCache.stats.misses - m0, 1);
  });

  await t.test('el caché caduca (TTL) y está limitado a 50 índices', async () => {
    let builds = 0;
    const build = async () => ++builds;
    const t0 = Date.now();
    await searchCache.get('ttl-user', false, build, t0);
    await searchCache.get('ttl-user', false, build, t0 + 1000);
    assert.equal(builds, 1);
    await searchCache.get('ttl-user', false, build, t0 + searchCache.TTL_MS + 1);
    assert.equal(builds, 2);
    for (let i = 0; i < 80; i++) await searchCache.get('lru-' + i, false, build, t0);
    assert.ok(searchCache.size() <= 50);
  });
});

test('OPT-2 orden de la lista de reportes del administrador', async () => {
  const u = await register();
  const admin = await register();
  await db.query("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
  const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
  const SEV = ['low', 'medium', 'high', 'critical'];
  for (let i = 0; i < 24; i++) {
    const r = await api('POST', '/api/tickets', { token: u.token, body: { ...ticket('Orden ' + i), severity: SEV[i % 4] } });
    await api('PATCH', '/api/admin/tickets/' + r.body.ticket.id, { token: admin.token, body: { status: STATUSES[(i * 7) % 4] } });
  }
  const list = await api('GET', '/api/admin/tickets', { token: admin.token });
  assert.equal(list.status, 200);
  const expected = (await db.query(`SELECT id FROM tickets ORDER BY FIELD(status,'open','in_progress','resolved','closed'),
    FIELD(severity,'critical','high','medium','low'), created_at DESC LIMIT 500`)).rows.map(r => r.id);
  const got = list.body.items.map(t => t.id);
  // Mismo orden por (estado, gravedad); dentro de un empate el orden por fecha también coincide
  const rank = id => list.body.items.find(t => t.id === id);
  assert.deepEqual(got.map(id => [rank(id).status, rank(id).severity]), expected.map(id => [rank(id).status, rank(id).severity]));
  const idx = await count("SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND INDEX_NAME = 'idx_tickets_rank'");
  assert.ok(idx > 0, 'existe el índice idx_tickets_rank');
});

test('RES-07 idempotencia de escrituras', async t => {
  const u = await register();
  const key = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  await t.test('la misma clave dos veces → 1 sola sesión y la segunda respuesta es la guardada', async () => {
    const k = key();
    const body = session('reintento idempotente', 50);
    const a = await api('POST', '/api/sessions', { token: u.token, body, headers: { 'Idempotency-Key': k } });
    const b = await api('POST', '/api/sessions', { token: u.token, body, headers: { 'Idempotency-Key': k } });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.equal(b.body.id, a.body.id);
    assert.equal(await count("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND notes = 'reintento idempotente'", [u.id]), 1);
  });

  await t.test('10 envíos simultáneos con la misma clave → 1 solo reporte', async () => {
    const k = key();
    const rs = await Promise.all(Array.from({ length: 10 }, () => api('POST', '/api/tickets', { token: u.token, body: ticket('Paralelo idempotente'), headers: { 'Idempotency-Key': k } })));
    assert.ok(rs.every(r => r.status === 201 || (r.status === 409 && r.body.code === 'IDEMPOTENCY_IN_PROGRESS')), JSON.stringify(rs.map(r => r.status)));
    assert.equal(await count("SELECT COUNT(*) n FROM tickets WHERE user_id = ? AND title = 'Paralelo idempotente'", [u.id]), 1);
    const again = await api('POST', '/api/tickets', { token: u.token, body: ticket('Paralelo idempotente'), headers: { 'Idempotency-Key': k } });
    assert.equal(again.status, 201);
    assert.equal(again.body.ticket.id, rs.find(r => r.status === 201).body.ticket.id);
  });

  await t.test('la misma clave con otro contenido → 422 y no se guarda nada', async () => {
    const k = key();
    await api('POST', '/api/tickets', { token: u.token, body: ticket('Primero'), headers: { 'Idempotency-Key': k } });
    const r = await api('POST', '/api/tickets', { token: u.token, body: ticket('Otro distinto'), headers: { 'Idempotency-Key': k } });
    assert.equal(r.status, 422);
    assert.equal(await count("SELECT COUNT(*) n FROM tickets WHERE user_id = ? AND title = 'Otro distinto'", [u.id]), 0);
  });

  await t.test('la clave es por usuario: otro usuario con la misma clave crea su propio registro', async () => {
    const k = key();
    const other = await register();
    const a = await api('POST', '/api/tickets', { token: u.token, body: ticket('Por usuario'), headers: { 'Idempotency-Key': k } });
    const b = await api('POST', '/api/tickets', { token: other.token, body: ticket('Por usuario'), headers: { 'Idempotency-Key': k } });
    assert.notEqual(a.body.ticket.id, b.body.ticket.id);
  });

  await t.test('una solicitud inválida (400) con clave se repite igual, sin ejecutar la ruta', async () => {
    const k = key();
    const a = await api('POST', '/api/sessions', { token: u.token, body: { type: 'nadar' }, headers: { 'Idempotency-Key': k } });
    const b = await api('POST', '/api/sessions', { token: u.token, body: { type: 'nadar' }, headers: { 'Idempotency-Key': k } });
    assert.equal(a.status, 400);
    assert.equal(b.status, 400);
    assert.deepEqual(b.body, a.body);
  });

  await t.test('clave con formato inválido → 400', async () => {
    const r = await api('POST', '/api/sessions', { token: u.token, body: session('x'), headers: { 'Idempotency-Key': 'a b' } });
    assert.equal(r.status, 400);
  });

  await t.test('sin clave todo funciona como antes (cada envío crea un registro)', async () => {
    await api('POST', '/api/sessions', { token: u.token, body: session('sin clave', 70) });
    await api('POST', '/api/sessions', { token: u.token, body: session('sin clave', 70) });
    assert.equal(await count("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND notes = 'sin clave'", [u.id]), 2);
  });
});

test('Defectos encontrados en la P12', async t => {
  await t.test('D-14 el límite de login es por IP real del cliente, no global (trust proxy)', async () => {
    const login = ip => api('POST', '/api/auth/login', { body: { email: 'nadie@fitpulse.test', password: 'xxxxxxxx' }, headers: { 'X-Forwarded-For': ip } });
    let last;
    for (let i = 0; i < 21; i++) last = await login('203.0.113.7');
    assert.equal(last.status, 429, 'la IP que abusa queda bloqueada');
    const other = await login('198.51.100.9');
    assert.equal(other.status, 401, 'otro usuario desde otra IP todavía puede intentar');
  });

  await t.test('D-15 un token con sub numérico se rechaza (no coincide con user_id por conversión de tipos)', async () => {
    const token = jwt.sign({ sub: 0, email: 'x' }, process.env.JWT_SECRET);
    const r = await api('GET', '/api/sessions', { token });
    assert.equal(r.status, 401);
  });
});
