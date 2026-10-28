/**
 * Pruebas de la API REST de FitPulse contra una base MySQL real.
 * Usa la base indicada en TEST_DB_NAME (por defecto fitpulse_test), que se
 * borra y se vuelve a crear al iniciar. Ejecutar con:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_NAME = process.env.TEST_DB_NAME || 'fitpulse_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

const mysql = require('mysql2/promise');
const db = require('../db');
const app = require('../server');

let server;
let base;
const TZ = -360; // Ciudad de México

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Timezone-Offset': String(TZ),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function register(email, name = 'Prueba') {
  const r = await api('POST', '/api/auth/register', { body: { email, password: 'password123', name } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
}

test.before(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${process.env.DB_NAME}\``);
  await conn.end();
  await db.init();
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
});

test('salud y versión', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('registro e inicio de sesión', async t => {
  await t.test('registra y devuelve token sin datos sensibles', async () => {
    const r = await api('POST', '/api/auth/register', {
      body: { email: 'Ana@Correo.com ', password: 'password123', name: 'Ana Torres', weight_kg: 62, height_cm: 165, age: 28 },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.token);
    assert.equal(r.body.user.email, 'ana@correo.com');
    assert.equal(r.body.user.role, 'user');
    assert.equal(r.body.user.weight_kg, 62);
    assert.equal(r.body.user.password_hash, undefined);
  });

  await t.test('rechaza correo repetido, contraseña corta y correo inválido', async () => {
    assert.equal((await api('POST', '/api/auth/register', { body: { email: 'ana@correo.com', password: 'password123' } })).status, 409);
    assert.equal((await api('POST', '/api/auth/register', { body: { email: 'b@correo.com', password: 'corta' } })).status, 400);
    assert.equal((await api('POST', '/api/auth/register', { body: { email: 'no-es-correo', password: 'password123' } })).status, 400);
    assert.equal((await api('POST', '/api/auth/register', { body: { email: '   ', password: '        ' } })).status, 400);
  });

  await t.test('login correcto y mensaje genérico si falla', async () => {
    const ok = await api('POST', '/api/auth/login', { body: { email: 'ana@correo.com', password: 'password123' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    const badPass = await api('POST', '/api/auth/login', { body: { email: 'ana@correo.com', password: 'incorrecta1' } });
    const noUser = await api('POST', '/api/auth/login', { body: { email: 'nadie@correo.com', password: 'password123' } });
    assert.equal(badPass.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(badPass.body.error, noUser.body.error);
  });

  await t.test('rutas protegidas exigen token', async () => {
    assert.equal((await api('GET', '/api/goals')).status, 401);
    assert.equal((await api('GET', '/api/profile', { token: 'token-falso' })).status, 401);
    assert.equal((await api('GET', '/api/workspaces/default/files')).status, 401);
  });
});

test('perfil', async () => {
  const token = await register('perfil@correo.com', 'Perfil');
  const r = await api('PUT', '/api/profile', { token, body: { name: 'Perfil Editado', weight_kg: 70.5, height_cm: 172, age: 30, daily_step_goal: 8000 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, 'Perfil Editado');
  assert.equal(r.body.user.weight_kg, 70.5);
  assert.equal(r.body.user.daily_step_goal, 8000);

  // La meta diaria de pasos sigue a la del perfil
  const goals = await api('GET', '/api/goals', { token });
  const steps = goals.body.find(g => g.type === 'steps');
  assert.equal(steps.target, 8000);

  assert.equal((await api('PUT', '/api/profile', { token, body: { age: 500 } })).status, 400);
  assert.equal((await api('PUT', '/api/profile', { token, body: {} })).status, 400);
});

test('eliminar cuenta requiere contraseña y borra sus datos', async () => {
  const token = await register('borrar@correo.com', 'Borrar');
  assert.equal((await api('DELETE', '/api/profile', { token, body: { password: 'incorrecta1' } })).status, 401);
  assert.equal((await api('DELETE', '/api/profile', { token, body: {} })).status, 400);
  assert.equal((await api('DELETE', '/api/profile', { token, body: { password: 'password123' } })).status, 200);
  const login = await api('POST', '/api/auth/login', { body: { email: 'borrar@correo.com', password: 'password123' } });
  assert.equal(login.status, 401);
  const left = await db.query("SELECT COUNT(*) AS n FROM goals g LEFT JOIN users u ON u.id = g.user_id WHERE u.id IS NULL");
  assert.equal(Number(left.rows[0].n), 0);
});

test('metas y sesiones', async t => {
  const token = await register('metas@correo.com', 'Metas');
  let distanceGoal;

  await t.test('el registro crea una meta de pasos', async () => {
    const r = await api('GET', '/api/goals', { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].type, 'steps');
    assert.equal(r.body[0].current, 0);
    assert.equal(r.body[0].history.length, 7);
  });

  await t.test('crea metas con periodo y valida datos', async () => {
    const r = await api('POST', '/api/goals', { token, body: { type: 'distance', target: 5, period: 'weekly', title: 'Correr 5 km' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.period, 'weekly');
    assert.equal(r.body.unit, 'km');
    distanceGoal = r.body;
    assert.equal((await api('POST', '/api/goals', { token, body: { type: 'volar', target: 5 } })).status, 400);
    assert.equal((await api('POST', '/api/goals', { token, body: { type: 'steps', target: -1 } })).status, 400);
  });

  await t.test('registrar una sesión actualiza el avance y notifica', async () => {
    const started = new Date(Date.now() - 40 * 60_000);
    const r = await api('POST', '/api/sessions', {
      token,
      body: {
        type: 'running',
        started_at: started.toISOString(),
        duration_sec: 1800,
        distance_km: 5.2,
        steps: 5400,
        calories: 340,
        avg_heart_rate: 152,
        max_heart_rate: 178,
        hr_samples: [120, 140, 150, 160, 178],
        device_name: 'FitPulse Band',
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.duration_min, 30);
    assert.equal(r.body.distance_km, 5.2);
    assert.deepEqual(r.body.hr_samples, [120, 140, 150, 160, 178]);
    assert.deepEqual(r.body.goals_completed, [distanceGoal.id]);

    const goals = await api('GET', '/api/goals', { token });
    const dist = goals.body.find(g => g.id === distanceGoal.id);
    assert.equal(dist.current, 5.2);
    assert.equal(dist.done, true);
    const steps = goals.body.find(g => g.type === 'steps');
    assert.equal(steps.current, 5400);

    const n = await api('GET', '/api/notifications', { token });
    const kinds = n.body.items.map(i => i.kind);
    assert.ok(kinds.includes('session'));
    assert.ok(kinds.includes('goal'));
    assert.ok(kinds.includes('heart'));
  });

  await t.test('consulta, filtra y elimina sesiones', async () => {
    await api('POST', '/api/sessions', {
      token,
      body: { type: 'walking', started_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), duration_sec: 2700, distance_km: 3.9, steps: 5000 },
    });
    const all = await api('GET', '/api/sessions', { token });
    assert.equal(all.body.length, 2);
    assert.equal(all.body[0].type, 'running'); // más reciente primero
    assert.equal(all.body[0].hr_samples, undefined);

    const walking = await api('GET', '/api/sessions?type=walking', { token });
    assert.equal(walking.body.length, 1);

    const one = await api('GET', `/api/sessions/${walking.body[0].id}`, { token });
    assert.equal(one.status, 200);
    assert.ok(Array.isArray(one.body.hr_samples));

    const summary = await api('GET', '/api/sessions/summary', { token });
    assert.equal(summary.body.total_sessions, 2);
    assert.equal(summary.body.total_km, 9.1);

    assert.equal((await api('DELETE', `/api/sessions/${walking.body[0].id}`, { token })).status, 200);
    assert.equal((await api('DELETE', `/api/sessions/${walking.body[0].id}`, { token })).status, 404);
  });

  await t.test('valida sesiones', async () => {
    assert.equal((await api('POST', '/api/sessions', { token, body: { type: 'running' } })).status, 400);
    assert.equal((await api('POST', '/api/sessions', { token, body: { started_at: 'ayer' } })).status, 400);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal((await api('POST', '/api/sessions', { token, body: { started_at: future } })).status, 400);
    const now = new Date().toISOString();
    assert.equal((await api('POST', '/api/sessions', { token, body: { started_at: now, avg_heart_rate: 900 } })).status, 400);
  });

  await t.test('avance manual (sueño) y edición de metas', async () => {
    const g = await api('POST', '/api/goals', { token, body: { type: 'sleep', target: 8 } });
    const p = await api('PATCH', `/api/goals/${g.body.id}`, { token, body: { manual_value: 8 } });
    assert.equal(p.status, 200);
    assert.equal(p.body.goal.done, true);
    assert.equal((await api('DELETE', `/api/goals/${g.body.id}`, { token })).status, 200);
  });

  await t.test('un usuario no ve ni borra datos de otro', async () => {
    const other = await register('otro@correo.com', 'Otro');
    assert.equal((await api('GET', '/api/sessions', { token: other })).body.length, 0);
    assert.equal((await api('DELETE', `/api/goals/${distanceGoal.id}`, { token: other })).status, 404);
  });
});

test('métricas y dispositivos', async t => {
  const token = await register('wear@correo.com', 'Wear');
  let deviceId;

  await t.test('registra un wearable y sincroniza lecturas', async () => {
    const d = await api('POST', '/api/devices', { token, body: { name: 'FitPulse Band', type: 'wearable' } });
    assert.equal(d.status, 201);
    deviceId = d.body.id;

    for (const hr of [64, 61, 72]) {
      const r = await api('POST', `/api/devices/${deviceId}/metrics/user`, { token, body: { heart_rate: hr, steps: 500, battery: 15 } });
      assert.equal(r.status, 201);
    }
    const list = await api('GET', '/api/devices', { token });
    assert.equal(list.body[0].status, 'linked');
    assert.equal(list.body[0].battery, 15);
    assert.ok(list.body[0].last_sync_at);

    const n = await api('GET', '/api/notifications', { token });
    assert.ok(n.body.items.some(i => i.kind === 'battery'));
    assert.ok(n.body.items.some(i => i.kind === 'sync'));

    assert.equal((await api('POST', `/api/devices/${deviceId}/metrics/user`, { token, body: { heart_rate: 999 } })).status, 400);
  });

  await t.test('el resumen combina sesiones y lecturas del wearable', async () => {
    await api('POST', '/api/sessions', {
      token,
      body: { type: 'cycling', started_at: new Date(Date.now() - 3600_000).toISOString(), duration_sec: 3000, distance_km: 15, calories: 400 },
    });
    const r = await api('GET', '/api/metrics/summary?range=week', { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.days.length, 7);
    assert.equal(r.body.today.steps, 1500);
    assert.equal(r.body.today.km, 15);
    assert.equal(r.body.today.active_minutes, 50);
    assert.equal(r.body.today.heart_rate, 72);
    assert.equal(r.body.resting_hr.current, 61);
    assert.equal(r.body.by_type.cycling.minutes, 50);
    assert.ok(r.body.hr_today.length >= 1);

    const month = await api('GET', '/api/metrics/summary?range=month', { token });
    assert.equal(month.body.days.length, 30);
  });
});

test('notificaciones', async () => {
  const token = await register('avisos@correo.com', 'Avisos');
  const n = await api('GET', '/api/notifications', { token });
  assert.equal(n.body.unread, 1); // bienvenida
  const id = n.body.items[0].id;
  assert.equal((await api('PATCH', `/api/notifications/${id}/read`, { token })).status, 200);
  assert.equal((await api('GET', '/api/notifications', { token })).body.unread, 0);
  assert.equal((await api('DELETE', `/api/notifications/${id}`, { token })).status, 200);
  assert.equal((await api('GET', '/api/notifications', { token })).body.items.length, 0);
});

test('panel de administración por rol', async () => {
  // Registrarse con el nombre "superadmin" ya no da acceso de administrador.
  const fake = await register('falso@correo.com', 'superadmin');
  assert.equal((await api('GET', '/api/admin/users', { token: fake })).status, 403);

  await db.query("UPDATE users SET role = 'admin' WHERE email = 'falso@correo.com'");
  assert.equal((await api('GET', '/api/admin/users', { token: fake })).status, 200);
});

test('JSON mal formado y rutas inexistentes', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{malo' });
  assert.equal(res.status, 400);
  assert.equal((await api('GET', '/api/no-existe')).status, 404);
});
