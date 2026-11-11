#!/usr/bin/env node
/**
 * Práctica 12 · Prueba de estrés reproducible de la API de FitPulse.
 *
 *   node tests/stress/estres.js http://34.228.70.230                 # todos los escenarios
 *   node tests/stress/estres.js http://34.228.70.230 --solo busqueda  # uno solo
 *   node tests/stress/estres.js http://localhost:3000 --niveles 1,10,50 --n 200
 *
 * 1. Crea un usuario de prueba (estres.<fecha>@fitpulse.test) y le carga datos realistas:
 *    --sesiones 300 (con lecturas de ritmo cardíaco), --tickets 60 y sus notificaciones.
 * 2. Para cada escenario y cada nivel de usuarios concurrentes manda --n solicitudes y mide
 *    RPS, promedio, P50, P90, P95, máximo, % de errores, códigos HTTP y bytes.
 * 3. Borra las sesiones que creó la escritura. El usuario de prueba queda para repetir la
 *    prueba en las mismas condiciones con --email y --password (se imprimen al final).
 *
 * Solo módulos de Node 18+. Las conexiones se reutilizan (keep-alive), igual que la app.
 * Resultados: estres-<fecha>.json y estres-<fecha>.txt en la carpeta actual.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const args = process.argv.slice(2);
const BASE = (args.find(a => /^https?:\/\//.test(a)) || 'http://34.228.70.230').replace(/\/+$/, '');
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const LEVELS = opt('niveles', '1,5,10,20,40').split(',').map(Number);
const N = Number(opt('n', 100));
const ONLY = opt('solo', null);
const SEED_SESSIONS = Number(opt('sesiones', 300));
const SEED_TICKETS = Number(opt('tickets', 60));
const LABEL = opt('etiqueta', '');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
const r1 = x => (x == null ? null : Math.round(x * 10) / 10);

function pct(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null; }

function makeAgent(max) {
  const Agent = BASE.startsWith('https') ? https.Agent : http.Agent;
  return new Agent({ keepAlive: true, maxSockets: max, maxFreeSockets: max });
}

function request(agent, method, path, { body, token, headers = {} } = {}) {
  return new Promise(resolve => {
    const url = new URL(BASE + path);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { Accept: 'application/json', ...headers };
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    if (token) h.Authorization = 'Bearer ' + token;
    const t0 = performance.now();
    const req = lib.request(url, { method, headers: h, agent, timeout: 30000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* vacío o no JSON */ }
        resolve({ status: res.statusCode, ms: performance.now() - t0, bytes: buf.length, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, ms: performance.now() - t0, bytes: 0, json: null, error: e.code || e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function pool(total, concurrency, fn) {
  const results = new Array(total);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) { const i = next++; results[i] = await fn(i); }
  }));
  return results;
}

async function level(name, concurrency, makeReq) {
  const agent = makeAgent(concurrency);
  // Calentamiento: abre las conexiones para que no cuenten en la medición
  await pool(concurrency, concurrency, () => makeReq(agent, -1));
  const t0 = performance.now();
  const res = await pool(N, concurrency, i => makeReq(agent, i));
  const wall = performance.now() - t0;
  agent.destroy();
  const ms = res.map(r => r.ms).sort((a, b) => a - b);
  const ok = res.filter(r => r.status >= 200 && r.status < 300).length;
  const codes = {};
  for (const r of res) { const k = r.status || r.error; codes[k] = (codes[k] || 0) + 1; }
  const bytes = res.reduce((a, r) => a + r.bytes, 0);
  return {
    escenario: name, usuarios: concurrency, solicitudes: N, ok, errores: N - ok, error_pct: r1(((N - ok) / N) * 100),
    rps: r1(N / (wall / 1000)), prom_ms: r1(ms.reduce((a, b) => a + b, 0) / ms.length), p50_ms: r1(pct(ms, 0.5)),
    p90_ms: r1(pct(ms, 0.9)), p95_ms: r1(pct(ms, 0.95)), max_ms: r1(ms[ms.length - 1]), min_ms: r1(ms[0]),
    bytes_prom: Math.round(bytes / N), mbps: r1((bytes * 8) / (wall / 1000) / 1e6), duracion_s: r1(wall / 1000), codigos: codes,
    ids: res.map(r => r.json?.id).filter(Boolean),
  };
}

const TYPES = ['running', 'walking', 'cycling', 'gym', 'swimming'];
function sessionBody(i, tag) {
  const start = Date.now() - (i + 1) * 3.1 * 3600 * 1000; // una sesión cada ~3 h hacia atrás
  const dur = 1200 + (i % 7) * 300;
  return {
    type: TYPES[i % TYPES.length], started_at: new Date(start).toISOString(), duration_sec: dur,
    distance_km: Math.round((2 + (i % 9) * 0.8) * 100) / 100, steps: 2500 + (i % 11) * 700, calories: 140 + (i % 13) * 25,
    avg_heart_rate: 118 + (i % 30), max_heart_rate: 150 + (i % 20),
    hr_samples: Array.from({ length: 120 }, (_, k) => 110 + ((k * 7 + i) % 45)), // una lectura cada ~15 s
    notes: `${tag} sesión ${i} · carrera por el parque, ritmo constante`, device_name: 'FitPulse Band',
  };
}

(async () => {
  let email = opt('email', null);
  let password = opt('password', null);
  log(`FitPulse · Práctica 12 · Prueba de estrés contra ${BASE}${LABEL ? ' · ' + LABEL : ''}`);
  log(`Fecha: ${new Date().toISOString()} · Cliente: ${os.type()} ${os.release()} · ${os.cpus()[0]?.model?.trim()} · Node ${process.version}`);
  log(`Niveles: ${LEVELS.join(', ')} usuarios · ${N} solicitudes por nivel`);
  const setupAgent = makeAgent(10);
  let token;
  if (email && password) {
    const r = await request(setupAgent, 'POST', '/api/auth/login', { body: { email, password } });
    token = r.json?.token;
    if (!token) { log(`No se pudo iniciar sesión con ${email} (HTTP ${r.status})`); process.exit(1); }
    log(`Usuario de prueba existente: ${email}`);
  } else {
    email = `estres.${stamp.toLowerCase()}@fitpulse.test`;
    password = 'Estres-' + crypto.randomBytes(5).toString('hex');
    const r = await request(setupAgent, 'POST', '/api/auth/register', { body: { email, password, name: 'Prueba Estrés' } });
    token = r.json?.token;
    if (!token) { log(`No se pudo crear el usuario de prueba (HTTP ${r.status})`); process.exit(1); }
    // Metas para que las sesiones generen notificaciones como en el uso real
    for (const g of [{ type: 'steps', target: 8000, period: 'daily' }, { type: 'distance', target: 5, period: 'daily' }, { type: 'workouts', target: 4, period: 'weekly' }]) {
      await request(setupAgent, 'POST', '/api/goals', { token, body: g });
    }
    const t0 = performance.now();
    const seeded = await pool(SEED_SESSIONS, 10, i => request(setupAgent, 'POST', '/api/sessions', { token, body: sessionBody(i, 'datos') }));
    await pool(SEED_TICKETS, 10, i => request(setupAgent, 'POST', '/api/tickets', { token, body: {
      title: `Reporte de carga ${i}`, description: `La pantalla ${['Inicio', 'Metas', 'Sesiones'][i % 3]} tarda en cargar cuando hay muchas sesiones (${i})`,
      category: ['bug', 'performance', 'ui', 'data'][i % 4], severity: ['low', 'medium', 'high', 'critical'][i % 4], screen: 'Sesiones', platform: 'script' } }));
    log(`Usuario de prueba creado: ${email} · ${seeded.filter(r => r.status === 201).length} sesiones y ${SEED_TICKETS} reportes en ${r1((performance.now() - t0) / 1000)} s`);
  }
  setupAgent.destroy();

  const scenarios = {
    lectura: { desc: 'GET /api/sessions?limit=100 (lista de la app)', fn: (a) => request(a, 'GET', '/api/sessions?limit=100', { token }) },
    resumen: { desc: 'GET /api/metrics/summary?range=month (pantalla Métricas)', fn: (a) => request(a, 'GET', '/api/metrics/summary?range=month', { token }) },
    busqueda: { desc: 'GET /api/search?q=carrera parque (buscador)', fn: (a, i) => request(a, 'GET', '/api/search?q=' + encodeURIComponent(['carrera parque', 'bicicleta', 'reporte lento', 'ritmo constante'][Math.abs(i) % 4]), { token }) },
    escritura: { desc: 'POST /api/sessions (registrar sesión)', fn: (a, i) => request(a, 'POST', '/api/sessions', { token, body: { ...sessionBody(5000 + Math.abs(i), 'estres'), started_at: new Date(Date.now() - (i + 10) * 60000).toISOString(), hr_samples: [] } }) },
  };
  const out = { base: BASE, etiqueta: LABEL, fecha: new Date().toISOString(), usuario: email, niveles: LEVELS, n: N, resultados: [] };
  const created = [];
  for (const [key, sc] of Object.entries(scenarios)) {
    if (ONLY && ONLY !== key) continue;
    log(`\n== ${key}: ${sc.desc} ==`);
    log('usuarios    RPS   prom    P50    P90    P95    máx  errores  bytes   códigos');
    for (const lv of LEVELS) {
      const r = await level(key, lv, sc.fn);
      if (key === 'escritura') created.push(...r.ids);
      delete r.ids;
      out.resultados.push(r);
      log(`${String(lv).padStart(8)} ${String(r.rps).padStart(6)} ${String(r.prom_ms).padStart(6)} ${String(r.p50_ms).padStart(6)} ${String(r.p90_ms).padStart(6)} ${String(r.p95_ms).padStart(6)} ${String(r.max_ms).padStart(6)} ${String(r.error_pct + '%').padStart(8)} ${String(r.bytes_prom).padStart(6)}   ${JSON.stringify(r.codigos)}`);
    }
  }
  if (created.length) {
    const a = makeAgent(10);
    const del = await pool(created.length, 10, i => request(a, 'DELETE', '/api/sessions/' + created[i], { token }));
    a.destroy();
    log(`\nLimpieza: ${del.filter(r => r.status < 300).length}/${created.length} sesiones de la escritura eliminadas`);
  }
  log(`\nPara repetir en las mismas condiciones:\n  node estres.js ${BASE} --email ${email} --password ${password}`);
  const base = `estres-${stamp}`;
  fs.writeFileSync(base + '.json', JSON.stringify(out, null, 2));
  fs.writeFileSync(base + '.txt', lines.join('\n') + '\n');
  console.log(`\nArchivos: ${base}.json y ${base}.txt`);
})();
