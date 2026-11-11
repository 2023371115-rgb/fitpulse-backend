#!/usr/bin/env node
/**
 * Práctica 11 · Mediciones de conectividad, HTTP y carga contra el servidor real.
 *
 * Se ejecuta desde el equipo cliente (no desde el servidor):
 *   node tests/whitebox/medir-red.js http://34.228.70.230
 *
 * Solo usa módulos de Node (18 o superior), sin dependencias.
 * Crea un usuario de prueba propio (whitebox.<fecha>@fitpulse.test), así que no toca
 * los datos de otros usuarios, y al final borra las sesiones que creó.
 *
 * Genera en la carpeta actual:
 *   resultados-whitebox-<fecha>.json   todos los datos crudos
 *   resultados-whitebox-<fecha>.txt    resumen legible
 */
'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

const BASE = (process.argv[2] || 'http://34.228.70.230').replace(/\/+$/, '');
const HOST = new URL(BASE).hostname;
const PING_COUNT = 20;
const HTTP_SAMPLES = 10;
const TRANSFER_RUNS = 3;
const TRANSFER_BYTES = 2 * 1024 * 1024; // 2 MiB por medición
const LOAD_LEVELS = [1, 5, 10];
const LOAD_REQUESTS = 20;

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const out = { base: BASE, started_at: new Date().toISOString(), env: {}, ping: null, web: [], latency: {}, transfer: {}, load: {}, sensitive: [] };
const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };

// ───────── utilidades ─────────
function stats(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length);
  const p = q => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
  return { n: v.length, min: v[0], max: v[v.length - 1], avg, sd, p50: p(0.5), p95: p(0.95) };
}
const r1 = x => (x == null ? null : Math.round(x * 10) / 10);
const r3 = x => (x == null ? null : Math.round(x * 1000) / 1000);
const mbps = (bytes, ms) => (bytes * 8) / (ms / 1000) / 1e6;

/**
 * Petición HTTP con tiempos por fase (DNS, conexión TCP, primer byte, total).
 * Cada petición abre su propia conexión (sin keep-alive) para que las mediciones sean comparables.
 */
function request(method, path, { body, headers = {}, raw } = {}) {
  return new Promise(resolve => {
    const url = new URL(path.startsWith('http') ? path : BASE + path);
    const lib = url.protocol === 'https:' ? https : http;
    let payload = null;
    if (raw !== undefined) payload = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    else if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; }
    if (payload) headers['Content-Length'] = payload.length;
    const t0 = performance.now();
    const t = { dns: null, connect: null, ttfb: null, total: null };
    const req = lib.request(url, { method, headers, agent: false, timeout: 30000 }, res => {
      t.ttfb = performance.now() - t0;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        t.total = performance.now() - t0;
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* no es JSON */ }
        resolve({ status: res.statusCode, ms: t.total, timing: t, bytes: buf.length, sent: payload ? payload.length : 0, json, text: buf.toString('utf8', 0, 300) });
      });
    });
    req.on('socket', s => {
      s.on('lookup', () => { t.dns = performance.now() - t0; });
      s.on('connect', () => { t.connect = performance.now() - t0; });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, ms: performance.now() - t0, timing: t, bytes: 0, sent: 0, json: null, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function scanSensitive(label, res) {
  const s = JSON.stringify(res.json || res.text || '');
  const hits = ['password_hash', '"password"', 'JWT_SECRET', 'DB_PASSWORD', 'stack'].filter(k => s.includes(k));
  if (hits.length) out.sensitive.push({ label, hits });
}

// ───────── 0. entorno ─────────
function environment() {
  out.env = {
    os: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    cpu: os.cpus()[0]?.model, cores: os.cpus().length,
    ram_gb: r1(os.totalmem() / 1024 ** 3),
    node: process.version,
    servidor: BASE,
  };
  log('FitPulse · Práctica 11 · Mediciones contra ' + BASE);
  log('Fecha: ' + out.started_at);
  log(`Cliente: ${out.env.os} · ${out.env.cpu} · ${out.env.cores} núcleos · ${out.env.ram_gb} GB · Node ${out.env.node}`);
  log();
}

// ───────── 1. ping ICMP ─────────
function ping() {
  return new Promise(resolve => {
    const win = process.platform === 'win32';
    const args = win ? ['-n', String(PING_COUNT), HOST] : ['-c', String(PING_COUNT), HOST];
    let text = '';
    let p;
    try { p = spawn('ping', args); } catch (e) { resolve({ error: e.message }); return; }
    p.stdout.on('data', d => { text += d.toString('latin1'); });
    p.stderr.on('data', d => { text += d.toString('latin1'); });
    p.on('error', e => resolve({ error: e.message, raw: text }));
    p.on('close', () => {
      const times = [...text.matchAll(/(?:tiempo|time)\s*[=<]\s*([\d.,]+)\s*ms/gi)].map(m => Number(m[1].replace(',', '.')));
      const lost = PING_COUNT - times.length;
      resolve({ sent: PING_COUNT, received: times.length, loss_pct: (lost / PING_COUNT) * 100, times, stats: stats(times), raw: text.trim() });
    });
  });
}

// ───────── 2. pruebas de endpoints (códigos HTTP y JSON) ─────────
async function webCases(email, password) {
  const cases = [];
  const add = (id, desc, expected, res, extra = {}) => {
    const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
    cases.push({ id, desc, expected, status: res.status, ok, ms: r1(res.ms), bytes: res.bytes, body: res.json ?? res.text, ...extra });
    scanSensitive(id, res);
    return res;
  };

  add('W01', 'GET /api/health (consulta exitosa)', 200, await request('GET', '/api/health'));
  const reg = add('W02', 'POST /api/auth/register usuario válido', 201, await request('POST', '/api/auth/register', { body: { email, password, name: 'Prueba Whitebox' } }));
  const token = reg.json?.token;
  add('W03', 'POST /api/auth/register correo repetido', 409, await request('POST', '/api/auth/register', { body: { email, password, name: 'Prueba Whitebox' } }));
  add('W04', 'POST /api/auth/login contraseña incorrecta', 401, await request('POST', '/api/auth/login', { body: { email, password: 'incorrecta123' } }));
  add('W05', 'POST /api/auth/login JSON mal formado', 400, await request('POST', '/api/auth/login', { raw: '{"email": "x",', headers: { 'Content-Type': 'application/json' } }));
  add('W06', 'POST /api/auth/register correo con formato inválido', 400, await request('POST', '/api/auth/register', { body: { email: 'no-es-correo', password } }));
  const auth = { Authorization: 'Bearer ' + token };
  add('W07', 'GET /api/sessions sin token', 401, await request('GET', '/api/sessions'));
  add('W08', 'GET /api/sessions con token falso', 401, await request('GET', '/api/sessions', { headers: { Authorization: 'Bearer abc.def.ghi' } }));
  add('W09', 'GET /api/admin/users con usuario normal', 403, await request('GET', '/api/admin/users', { headers: { ...auth } }));
  add('W10', 'GET /api/sessions/<id inexistente>', 404, await request('GET', '/api/sessions/' + crypto.randomUUID(), { headers: { ...auth } }));
  add('W11', 'POST /api/sessions sin fecha de inicio', 400, await request('POST', '/api/sessions', { headers: { ...auth }, body: { type: 'running' } }));
  const startedAt = new Date(Date.now() - 40 * 60000).toISOString();
  add('W12', 'POST /api/sessions con fin anterior al inicio (validación semántica)', [400, 422], await request('POST', '/api/sessions', { headers: { ...auth }, body: { type: 'running', started_at: startedAt, ended_at: new Date(Date.now() - 60 * 60000).toISOString() } }));
  const sessionBody = { type: 'running', started_at: startedAt, duration_sec: 1800, distance_km: 5.2, steps: 6800, calories: 410, avg_heart_rate: 142, notes: 'whitebox' };
  const created = add('W13', 'POST /api/sessions válida', 201, await request('POST', '/api/sessions', { headers: { ...auth }, body: sessionBody }));
  const sid = created.json?.id;
  const read = add('W14', 'GET /api/sessions/:id recién creada', 200, await request('GET', '/api/sessions/' + sid, { headers: { ...auth } }));
  const s = read.json || {};
  const consistent = s.type === sessionBody.type && Number(s.distance_km) === sessionBody.distance_km && Number(s.steps) === sessionBody.steps && s.duration_sec === sessionBody.duration_sec;
  cases[cases.length - 1].consistent = consistent;
  add('W15', 'DELETE /api/sessions/:id (204 sin cuerpo esperado)', 204, await request('DELETE', '/api/sessions/' + sid, { headers: { ...auth } }));
  add('W16', 'GET /api/sessions/:id después de eliminar', 404, await request('GET', '/api/sessions/' + sid, { headers: { ...auth } }));
  add('W17', 'POST /api/tickets reporte válido', 201, await request('POST', '/api/tickets', { headers: { ...auth }, body: { title: 'Prueba whitebox', description: 'Reporte creado por el script de la práctica 11', category: 'other', severity: 'low', screen: 'Otra', platform: 'script', app_version: 'whitebox' } }));
  add('W18', 'POST /api/tickets con categoría no permitida', 400, await request('POST', '/api/tickets', { headers: { ...auth }, body: { title: 'Prueba', description: 'Descripción suficiente', category: 'inventada' } }));
  add('W19', 'GET /api/ruta-inexistente', 404, await request('GET', '/api/ruta-inexistente'));
  add('W21', 'GET /api/sessions?limit=5.5 (límite con decimales)', [200, 400], await request('GET', '/api/sessions?limit=5.5', { headers: { ...auth } }));
  const login = add('W20', 'POST /api/auth/login correcto', 200, await request('POST', '/api/auth/login', { body: { email, password } }));
  out.web = cases;

  log('== Pruebas de endpoints ==');
  for (const c of cases) log(`${c.ok ? 'CUMPLE ' : 'NO CUMPLE'} ${c.id} ${c.desc} · esperado ${[].concat(c.expected).join('/')} · obtenido ${c.status} · ${c.ms} ms · ${c.bytes} B${c.consistent === false ? ' · DATOS NO COINCIDEN' : ''}`);
  log(`Respuestas con datos sensibles: ${out.sensitive.length ? JSON.stringify(out.sensitive) : 'ninguna'}`);
  log();
  return login.json?.token || token;
}

// ───────── 3. latencia HTTP (10 solicitudes) ─────────
async function latency(token) {
  log('== Latencia HTTP (10 solicitudes consecutivas por endpoint) ==');
  for (const [name, path, headers] of [['health', '/api/health', {}], ['sessions', '/api/sessions?limit=20', { Authorization: 'Bearer ' + token }]]) {
    const rows = [];
    for (let i = 1; i <= HTTP_SAMPLES; i++) {
      const res = await request('GET', path, { headers: { ...headers } });
      rows.push({ n: i, status: res.status, ms: r1(res.ms), connect_ms: r1(res.timing.connect), ttfb_ms: r1(res.timing.ttfb), bytes: res.bytes });
    }
    const st = stats(rows.map(r => r.ms));
    out.latency[name] = { path, rows, stats: st, connect: stats(rows.map(r => r.connect_ms)), ttfb: stats(rows.map(r => r.ttfb_ms)) };
    log(`GET ${path}`);
    for (const r of rows) log(`  ${String(r.n).padStart(2)}  HTTP ${r.status}  ${String(r.ms).padStart(7)} ms  (TCP ${r.connect_ms} ms, 1er byte ${r.ttfb_ms} ms)  ${r.bytes} B`);
    log(`  promedio ${r1(st.avg)} ms · mín ${r1(st.min)} · máx ${r1(st.max)} · desv ${r1(st.sd)} · P95 ${r1(st.p95)}`);
  }
  log();
}

// ───────── 4. tasa de transferencia ─────────
async function transfer(token) {
  log(`== Tasa de transferencia (${TRANSFER_RUNS} mediciones de ${TRANSFER_BYTES / 1024 / 1024} MiB) ==`);
  const up = [], down = [];
  let lastPath = null;
  for (let i = 1; i <= TRANSFER_RUNS; i++) {
    const data = crypto.randomBytes(TRANSFER_BYTES);
    const boundary = '----fitpulse' + crypto.randomBytes(8).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="whitebox-${i}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      data, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await request('POST', '/api/workspaces/whitebox/files', { raw: body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: 'Bearer ' + token } });
    const row = { n: i, status: res.status, bytes: body.length, ms: r1(res.ms), mbps: res.status === 201 ? r3(mbps(body.length, res.ms)) : null };
    up.push(row);
    if (res.json?.file?.storage_path) lastPath = res.json.file.storage_path;
    log(`  subida ${i}: HTTP ${res.status} · ${body.length} B en ${row.ms} ms → ${row.mbps} Mbps`);
  }
  for (let i = 1; i <= TRANSFER_RUNS && lastPath; i++) {
    const res = await request('GET', lastPath);
    const row = { n: i, status: res.status, bytes: res.bytes, ms: r1(res.ms), mbps: res.status === 200 ? r3(mbps(res.bytes, res.ms)) : null };
    down.push(row);
    log(`  descarga ${i}: HTTP ${res.status} · ${res.bytes} B en ${row.ms} ms (${r3(row.ms / 1000)} s) → ${row.mbps} Mbps`);
  }
  out.transfer = { file_bytes: TRANSFER_BYTES, upload: up, download: down, upload_mbps: stats(up.map(r => r.mbps)), download_mbps: stats(down.map(r => r.mbps)) };
  log(`  promedio subida ${r3(out.transfer.upload_mbps?.avg)} Mbps · descarga ${r3(out.transfer.download_mbps?.avg)} Mbps`);
  log();
}

// ───────── 5. carga controlada ─────────
async function runLoad(level, makeRequest) {
  const results = [];
  let next = 0;
  const t0 = performance.now();
  async function worker() {
    while (next < LOAD_REQUESTS) {
      const i = next++;
      results[i] = await makeRequest(i);
    }
  }
  await Promise.all(Array.from({ length: level }, worker));
  const wall = performance.now() - t0;
  const ok = results.filter(r => r.status >= 200 && r.status < 300);
  const st = stats(results.map(r => r.ms));
  const bytes = results.reduce((a, r) => a + r.bytes + r.sent, 0);
  return {
    concurrency: level, requests: results.length, ok: ok.length, failed: results.length - ok.length,
    codes: results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {}),
    avg_ms: r1(st.avg), p95_ms: r1(st.p95), min_ms: r1(st.min), max_ms: r1(st.max),
    wall_ms: r1(wall), rps: r1(results.length / (wall / 1000)), mbps: r3(mbps(bytes, wall)), bytes,
    ids: results.map(r => r.json?.id).filter(Boolean),
  };
}

async function load(token) {
  log(`== Carga controlada (${LOAD_REQUESTS} solicitudes por escenario) ==`);
  const auth = { Authorization: 'Bearer ' + token };
  const created = [];
  out.load = { read: [], write: [] };
  for (const level of LOAD_LEVELS) {
    const r = await runLoad(level, () => request('GET', '/api/sessions?limit=20', { headers: { ...auth } }));
    delete r.ids;
    out.load.read.push(r);
    log(`  lectura  GET /api/sessions   ${String(level).padStart(2)} usuarios: prom ${r.avg_ms} ms · P95 ${r.p95_ms} · ok ${r.ok}/${r.requests} · ${r.rps} sol/s · ${r.mbps} Mbps`);
  }
  for (const level of LOAD_LEVELS) {
    const r = await runLoad(level, i => request('POST', '/api/sessions', { headers: { ...auth }, body: { type: 'walking', started_at: new Date(Date.now() - (i + 2) * 60000).toISOString(), duration_sec: 600, distance_km: 1.1, steps: 1400, notes: `carga-${level}-${i}` } }));
    created.push(...r.ids);
    delete r.ids;
    out.load.write.push(r);
    log(`  escritura POST /api/sessions  ${String(level).padStart(2)} usuarios: prom ${r.avg_ms} ms · P95 ${r.p95_ms} · ok ${r.ok}/${r.requests} · ${r.rps} sol/s · ${r.mbps} Mbps`);
  }
  // Limpieza: borra lo que creó la prueba de escritura
  let deleted = 0;
  for (const id of created) {
    const d = await request('DELETE', '/api/sessions/' + id, { headers: { ...auth } });
    if (d.status === 200 || d.status === 204) deleted++;
  }
  out.load.cleanup = { created: created.length, deleted };
  log(`  limpieza: ${deleted}/${created.length} sesiones de prueba eliminadas`);
  log();
}

(async () => {
  environment();
  log('== Ping ICMP ==');
  out.ping = await ping();
  if (out.ping.error || !out.ping.received) {
    log(`  Sin respuesta ICMP (${out.ping.error || out.ping.received + '/' + PING_COUNT + ' respuestas'}). El servidor o la red bloquean ping; se usan las mediciones HTTP.`);
  } else {
    const s = out.ping.stats;
    log(`  ${out.ping.received}/${out.ping.sent} respuestas · pérdida ${out.ping.loss_pct}% · mín ${s.min} ms · prom ${r1(s.avg)} ms · máx ${s.max} ms · desv ${r1(s.sd)} ms`);
  }
  log();
  const email = `whitebox.${stamp.toLowerCase()}@fitpulse.test`;
  const password = 'Whitebox-' + crypto.randomBytes(4).toString('hex');
  out.test_user = email;
  const token = await webCases(email, password);
  if (!token) { log('No se obtuvo token; se detiene la prueba. Revisa que el servidor responda.'); }
  else {
    // Datos de prueba: 20 sesiones del usuario de prueba para que las lecturas devuelvan contenido real
    const seeded = [];
    for (let i = 0; i < 20; i++) {
      const r = await request('POST', '/api/sessions', { headers: { Authorization: 'Bearer ' + token }, body: { type: ['running', 'walking', 'cycling', 'gym'][i % 4], started_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(), duration_sec: 1200 + i * 60, distance_km: 2 + i / 4, steps: 2500 + i * 300, calories: 150 + i * 10, avg_heart_rate: 120 + i, notes: 'whitebox-datos' } });
      if (r.json?.id) seeded.push(r.json.id);
    }
    out.seeded_sessions = seeded.length;
    log(`Datos de prueba: ${seeded.length} sesiones creadas para el usuario ${email}`);
    log();
    await latency(token);
    await transfer(token);
    await load(token);
    let del = 0;
    for (const id of seeded) { const d = await request('DELETE', '/api/sessions/' + id, { headers: { Authorization: 'Bearer ' + token } }); if (d.status < 300) del++; }
    log(`Limpieza final: ${del}/${seeded.length} sesiones de datos de prueba eliminadas`);
  }
  out.finished_at = new Date().toISOString();
  const base = `resultados-whitebox-${stamp}`;
  fs.writeFileSync(base + '.json', JSON.stringify(out, null, 2));
  fs.writeFileSync(base + '.txt', lines.join('\n') + '\n');
  console.log(`\nListo. Archivos: ${base}.json y ${base}.txt`);
})();
