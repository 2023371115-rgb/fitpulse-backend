/**
 * Práctica 11 · Pruebas white box de la API.
 *
 * Cada bloque recorre los caminos de un controlador (grafo de flujo en el reporte):
 *   E1  POST /api/auth/login           (routes/auth.js)      complejidad 12
 *   E2  POST /api/sessions             (routes/sessions.js)  complejidad 22
 *   E3  POST /api/tickets y PATCH /api/admin/tickets/:id     complejidad 12
 * y los defectos encontrados al revisar el código (pruebas marcadas como "todo":
 * describen el comportamiento correcto y hoy fallan sin romper la suite).
 *
 *   node --test --test-concurrency=1 --experimental-test-coverage tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.DB_NAME = process.env.WB_DB_NAME || 'fitpulse_wb';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

const mysql = require('mysql2/promise');
const db = require('../db');
const app = require('../server');

let server;
let base;

async function api(method, p, { token, body, raw, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, text };
}

async function register(email, password = 'password123') {
  const r = await api('POST', '/api/auth/register', { body: { email, password, name: 'Prueba WB' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.id };
}

const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString();

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

// ───────── E1 · POST /api/auth/login ─────────
test('E1 POST /api/auth/login', async t => {
  await register('login@wb.test');
  const long72 = 'p'.repeat(72);
  await register('largo@wb.test', long72);
  const inactive = await register('inactivo@wb.test');
  await db.query('UPDATE users SET active = 0 WHERE id = ?', [inactive.id]);

  await t.test('P1 sin correo → 400 (C1 verdadero)', async () => {
    assert.equal((await api('POST', '/api/auth/login', { body: { password: 'password123' } })).status, 400);
  });
  await t.test('P1b correo con solo espacios y sin contraseña → 400 (C1 falso, C2 verdadero)', async () => {
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'login@wb.test' } })).status, 400);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: '   ', password: 'x' } })).status, 400);
  });
  await t.test('P2 correo de más de 255 caracteres → 401 genérico (no se consulta la BD)', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: 'a'.repeat(250) + '@x.com', password: 'password123' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciales incorrectas.');
  });
  await t.test('P2b límite de contraseña: 72 entra, 73 se rechaza', async () => {
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'largo@wb.test', password: long72 } })).status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'largo@wb.test', password: long72 + 'p' } })).status, 401);
  });
  await t.test('P3 correo que no existe → 401 con el mismo mensaje', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: 'nadie@wb.test', password: 'password123' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciales incorrectas.');
  });
  await t.test('P4 contraseña incorrecta → 401 con el mismo mensaje', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: 'login@wb.test', password: 'incorrecta1' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Credenciales incorrectas.');
  });
  await t.test('P5 cuenta desactivada → 403 (autenticado pero sin permiso)', async () => {
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'inactivo@wb.test', password: 'password123' } })).status, 403);
  });
  await t.test('P6 login correcto → 200, token y sin datos sensibles', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: ' LOGIN@wb.test ', password: 'password123' } });
    assert.equal(r.status, 200);
    assert.match(r.body.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(r.text.includes('password'), false);
  });
  await t.test('P7 JSON mal formado → 400 del manejador global', async () => {
    const r = await api('POST', '/api/auth/login', { raw: '{"email":' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Solicitud invalida');
  });
});

// ───────── E2 · POST /api/sessions ─────────
test('E2 POST /api/sessions', async t => {
  const { token, id: userId } = await register('sesiones@wb.test');
  const post = body => api('POST', '/api/sessions', { token, body });

  await t.test('P1 sin token → 401; token alterado → 401', async () => {
    assert.equal((await api('POST', '/api/sessions', { body: {} })).status, 401);
    assert.equal((await api('POST', '/api/sessions', { token: token + 'x', body: {} })).status, 401);
  });
  await t.test('P2 sin fecha de inicio o con fecha inválida → 400', async () => {
    assert.equal((await post({ type: 'running' })).status, 400);
    assert.equal((await post({ type: 'running', started_at: 'ayer' })).status, 400);
  });
  await t.test('P3 fin anterior al inicio → 400', async () => {
    assert.equal((await post({ started_at: minutesAgo(10), ended_at: minutesAgo(20) })).status, 400);
  });
  await t.test('P4 inicio en el futuro: límite de 5 minutos', async () => {
    assert.equal((await post({ started_at: new Date(Date.now() + 6 * 60000).toISOString() })).status, 400);
    assert.equal((await post({ started_at: new Date(Date.now() + 4 * 60000).toISOString() })).status, 201);
  });
  await t.test('P5 solo duration_sec: el servidor calcula ended_at', async () => {
    const r = await post({ type: 'cycling', started_at: minutesAgo(60), duration_sec: 1800 });
    assert.equal(r.status, 201);
    assert.equal(r.body.duration_sec, 1800);
  });
  await t.test('P6 tipo desconocido se guarda como "other"', async () => {
    const r = await post({ type: 'parkour', started_at: minutesAgo(30) });
    assert.equal(r.status, 201);
    assert.equal(r.body.type, 'other');
  });
  await t.test('L1 valores límite de distancia (0 a 500 km)', async () => {
    assert.equal((await post({ started_at: minutesAgo(5), distance_km: 500 })).status, 201);
    assert.equal((await post({ started_at: minutesAgo(5), distance_km: 500.1 })).status, 400);
    assert.equal((await post({ started_at: minutesAgo(5), distance_km: -0.1 })).status, 400);
  });
  await t.test('L2 hr_samples: debe ser lista de hasta 720 valores entre 25 y 250', async () => {
    assert.equal((await post({ started_at: minutesAgo(5), hr_samples: 'muchos' })).status, 400);
    assert.equal((await post({ started_at: minutesAgo(5), hr_samples: Array(721).fill(120) })).status, 400);
    assert.equal((await post({ started_at: minutesAgo(5), hr_samples: [120, 300] })).status, 400);
    assert.equal((await post({ started_at: minutesAgo(5), hr_samples: Array(720).fill(120) })).status, 201);
  });
  await t.test('P7 ritmo máximo alto (≥175) genera notificación de corazón', async () => {
    assert.equal((await post({ started_at: minutesAgo(5), max_heart_rate: 175 })).status, 201);
    const r = await db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'heart'", [userId]);
    assert.equal(Number(r.rows[0].n), 1);
  });
  await t.test('P8 la sesión completa una meta → goals_completed la incluye', async () => {
    // Usuario nuevo: las sesiones anteriores de esta prueba ya superan cualquier meta de distancia de hoy
    const fresh = await register('meta@wb.test');
    const g = await api('POST', '/api/goals', { token: fresh.token, body: { type: 'distance', target: 3, period: 'daily' } });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    const r = await api('POST', '/api/sessions', { token: fresh.token, body: { type: 'running', started_at: minutesAgo(40), duration_sec: 1500, distance_km: 3.5 } });
    assert.equal(r.status, 201);
    assert.ok(r.body.goals_completed.includes(g.body.id));
  });
  await t.test('P9 persistencia: lo creado se lee igual por id y aparece en la lista', async () => {
    const c = await post({ type: 'walking', started_at: minutesAgo(90), duration_sec: 600, distance_km: 1.25, steps: 1500, notes: 'persistencia' });
    const r = await api('GET', '/api/sessions/' + c.body.id, { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.distance_km, 1.25);
    assert.equal(r.body.steps, 1500);
    assert.equal(r.body.notes, 'persistencia');
    const list = await api('GET', '/api/sessions?limit=200', { token });
    assert.ok(list.body.some(s => s.id === c.body.id));
  });
  await t.test('P10 aislamiento: otro usuario no puede leer ni borrar la sesión (404)', async () => {
    const other = await register('otro@wb.test');
    const c = await post({ started_at: minutesAgo(15) });
    assert.equal((await api('GET', '/api/sessions/' + c.body.id, { token: other.token })).status, 404);
    assert.equal((await api('DELETE', '/api/sessions/' + c.body.id, { token: other.token })).status, 404);
    assert.equal((await api('GET', '/api/sessions/' + c.body.id, { token })).status, 200);
  });
  await t.test('P11 diez escrituras concurrentes del mismo usuario se guardan todas', async () => {
    const before = (await api('GET', '/api/sessions?limit=200', { token })).body.length;
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => post({ started_at: minutesAgo(200 + i), notes: 'concurrente' })));
    assert.ok(rs.every(r => r.status === 201));
    const after = (await api('GET', '/api/sessions?limit=200', { token })).body.length;
    assert.equal(after - before, 10);
  });
  await t.test('D-01 (corregido) límites con decimales o fuera de rango ya no dan 500', async () => {
    const r = await api('GET', '/api/sessions?limit=5.5', { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 5);
    for (const q of ['limit=-3', 'limit=1e400', 'limit=abc', 'limit=99999']) {
      assert.equal((await api('GET', '/api/sessions?' + q, { token })).status, 200, q);
    }
    assert.equal((await api('GET', '/api/notifications?limit=2.7', { token })).status, 200);
    assert.equal((await api('GET', '/api/search?q=carrera&size=3.3', { token })).status, 200);
  });
  await t.test('D-05 DELETE exitoso debería responder 204 sin cuerpo', { todo: 'Mejora D-05: hoy responde 200 con {"ok":true}' }, async () => {
    const c = await post({ started_at: minutesAgo(3) });
    const r = await api('DELETE', '/api/sessions/' + c.body.id, { token });
    assert.equal(r.status, 204);
  });
});

// ───────── E3 · reportes de fallos ─────────
test('E3 POST /api/tickets y PATCH /api/admin/tickets/:id', async t => {
  const user = await register('tickets@wb.test');
  const other = await register('ajeno@wb.test');
  const admin = await register('admin@wb.test');
  await db.query("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
  const valid = { title: 'Se cierra la app', description: 'Al guardar una sesión la app se cierra sola', category: 'crash', severity: 'high' };
  let ticketId;

  await t.test('P1 título de menos de 3 caracteres o descripción de menos de 10 → 400', async () => {
    assert.equal((await api('POST', '/api/tickets', { token: user.token, body: { ...valid, title: 'ab' } })).status, 400);
    assert.equal((await api('POST', '/api/tickets', { token: user.token, body: { ...valid, description: 'corta' } })).status, 400);
  });
  await t.test('L1 título de 140 caracteres entra y de 141 no', async () => {
    assert.equal((await api('POST', '/api/tickets', { token: user.token, body: { ...valid, title: 't'.repeat(140) } })).status, 201);
    assert.equal((await api('POST', '/api/tickets', { token: user.token, body: { ...valid, title: 't'.repeat(141) } })).status, 400);
  });
  await t.test('P2 categoría no permitida → 400; vacía usa "bug" por defecto', async () => {
    assert.equal((await api('POST', '/api/tickets', { token: user.token, body: { ...valid, category: 'inventada' } })).status, 400);
    const r = await api('POST', '/api/tickets', { token: user.token, body: { ...valid, category: '' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.ticket.category, 'bug');
  });
  await t.test('P3 reporte válido → 201 con folio FP-0000 y estado abierto', async () => {
    const r = await api('POST', '/api/tickets', { token: user.token, body: valid });
    assert.equal(r.status, 201);
    assert.match(r.body.ticket.code, /^FP-\d{4}$/);
    assert.equal(r.body.ticket.status, 'open');
    ticketId = r.body.ticket.id;
  });
  await t.test('P4 otro usuario no ve el reporte (404) y sin token es 401', async () => {
    assert.equal((await api('GET', '/api/tickets/' + ticketId, { token: other.token })).status, 404);
    assert.equal((await api('GET', '/api/tickets/' + ticketId)).status, 401);
  });
  await t.test('P5 usuario normal en el panel de administración → 403 (no 401)', async () => {
    assert.equal((await api('PATCH', '/api/admin/tickets/' + ticketId, { token: user.token, body: { status: 'resolved' } })).status, 403);
  });
  await t.test('P6 administrador con id inexistente → 404', async () => {
    assert.equal((await api('PATCH', '/api/admin/tickets/no-existe', { token: admin.token, body: { status: 'resolved' } })).status, 404);
  });
  await t.test('P7 estado no permitido → 400', async () => {
    assert.equal((await api('PATCH', '/api/admin/tickets/' + ticketId, { token: admin.token, body: { status: 'perdido' } })).status, 400);
  });
  await t.test('P8 resolver: guarda resolved_at, la nota y notifica al usuario', async () => {
    const r = await api('PATCH', '/api/admin/tickets/' + ticketId, { token: admin.token, body: { status: 'resolved', admin_note: 'Corregido en 0.4.1' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.ticket.resolved_at);
    assert.equal(r.body.ticket.admin_note, 'Corregido en 0.4.1');
    const n = await api('GET', '/api/notifications', { token: user.token });
    assert.ok(JSON.stringify(n.body).includes('Resuelto'));
  });
  await t.test('P9 cambio sin cambiar el estado no vuelve a notificar ni borra la nota', async () => {
    const before = (await api('GET', '/api/notifications', { token: user.token })).body;
    const r = await api('PATCH', '/api/admin/tickets/' + ticketId, { token: admin.token, body: { severity: 'low' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ticket.admin_note, 'Corregido en 0.4.1');
    const after = (await api('GET', '/api/notifications', { token: user.token })).body;
    assert.equal(JSON.stringify(after).length, JSON.stringify(before).length);
  });
  await t.test('P10 reabrir borra resolved_at', async () => {
    const r = await api('PATCH', '/api/admin/tickets/' + ticketId, { token: admin.token, body: { status: 'open' } });
    assert.equal(r.body.ticket.resolved_at, null);
  });
  await t.test('D-06 el mismo reporte reenviado (reintento) no debería duplicarse', { todo: 'Mejora D-06: no hay llave de idempotencia; cada reintento crea otro ticket' }, async () => {
    const key = { 'Idempotency-Key': 'reintento-1' };
    const a = await api('POST', '/api/tickets', { token: user.token, body: valid, headers: key });
    const b = await api('POST', '/api/tickets', { token: user.token, body: valid, headers: key });
    assert.equal(a.body.ticket.id, b.body.ticket.id);
  });
  await t.test('D-02 (corregido) workspaceId con "../" se rechaza con 400 y no escribe fuera de uploads/', async () => {
    const form = new FormData();
    form.append('file', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'prueba.pdf');
    const res = await fetch(base + '/api/workspaces/..%2F..%2Fwb-traversal/files', { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
    const outside = path.join(__dirname, '..', '..', 'wb-traversal');
    const escaped = fs.existsSync(outside);
    fs.rmSync(outside, { recursive: true, force: true });
    assert.equal(escaped, false, `HTTP ${res.status}: se creó ${outside}`);
    assert.equal(res.status, 400);
  });
  await t.test('D-02b un workspaceId válido sigue funcionando', async () => {
    const form = new FormData();
    form.append('file', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'prueba.pdf');
    const res = await fetch(base + '/api/workspaces/whitebox_ok-1/files', { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
    const json = await res.json();
    assert.equal(res.status, 201);
    assert.match(json.file.storage_path, /^\/uploads\/whitebox_ok-1\//);
    fs.rmSync(path.join(__dirname, '..', 'uploads', 'whitebox_ok-1'), { recursive: true, force: true });
  });
});
