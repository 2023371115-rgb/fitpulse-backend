/**
 * Datos de demostración de FitPulse.
 * Crea (o reinicia) la cuenta demo de Ana Torres con sesiones, metas,
 * un wearable con 14 días de lecturas y notificaciones.
 *
 *   npm run seed
 *
 * Variables opcionales: SEED_EMAIL, SEED_PASSWORD, SEED_TZ (minutos, -360 = CDMX).
 * Solo toca la cuenta demo; no modifica otros usuarios.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { DAY_MS, startOfLocalDay } = require('../services/time');

const EMAIL = (process.env.SEED_EMAIL || 'ana@correo.com').toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD || 'fitpulse123';
const TZ = Number(process.env.SEED_TZ || -360);

const now = new Date();
const today = startOfLocalDay(now, TZ);
const at = (daysAgo, h, m = 0) => new Date(today.getTime() - daysAgo * DAY_MS + (h * 60 + m) * 60_000);

/** Pasos por día de los últimos 7 días (el último es hoy), iguales a la app. */
const WEEK_STEPS = [8120, 9650, 5870, 11240, 8430, 12890, 7240];
/** Ritmo cardíaco en reposo, 14 días (el último es hoy). */
const RESTING = [66, 65, 66, 64, 65, 64, 63, 64, 63, 63, 62, 63, 62, 62];

// tipo, días atrás, hora, minuto, minutos, km, bpm prom, bpm máx, kcal, pasos
const SESSIONS = [
  ['running', 0, 7, 10, 32, 4.8, 156, 176, 342, 5180],
  ['walking', 1, 19, 5, 45, 3.9, 104, 121, 198, 5020],
  ['cycling', 3, 8, 30, 70, 18.0, 132, 158, 610, 0],
  ['running', 4, 7, 0, 25, 3.7, 150, 171, 268, 3990],
  ['gym', 5, 18, 40, 50, 0, 118, 149, 290, 820],
  ['walking', 6, 20, 15, 38, 3.2, 98, 112, 160, 4110],
  ['running', 8, 6, 50, 40, 6.1, 158, 179, 430, 6540],
  ['cycling', 10, 17, 20, 55, 14.2, 128, 151, 480, 0],
];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hrSamples(seed, avg, max, points = 36) {
  const r = rng(seed);
  let hr = avg - 30;
  const out = [];
  for (let i = 0; i < points; i++) {
    const target = i < 5 ? avg - 30 + i * 6 : avg + Math.sin(i / 4) * 8;
    hr += (target - hr) * 0.35 + r() * 6 - 3;
    out.push(Math.round(Math.min(hr, max)));
  }
  out[Math.floor(points * 0.7)] = max;
  return out;
}

async function main() {
  await db.init();
  const r = rng(42);

  await db.query('DELETE FROM users WHERE email = ?', [EMAIL]);
  const userId = uuidv4();
  await db.query(
    `INSERT INTO users(id, email, password_hash, name, role, weight_kg, height_cm, age, daily_step_goal)
     VALUES(?, ?, ?, 'Ana Torres', 'user', 62, 165, 28, 10000)`,
    [userId, EMAIL, await bcrypt.hash(PASSWORD, 10)]
  );

  // Wearable vinculado
  const deviceId = uuidv4();
  await db.query(
    `INSERT INTO devices(id, owner_id, name, type, status, token, battery, last_sync_at, created_at)
     VALUES(?, ?, 'FitPulse Band', 'wearable', 'linked', ?, 84, ?, ?)`,
    [deviceId, userId, crypto.randomBytes(32).toString('hex'), new Date(now.getTime() - 5 * 60_000), at(30, 10)]
  );

  // Sesiones
  const sessionSteps = {};
  let n = 0;
  for (const [type, daysAgo, h, m, min, km, avg, max, kcal, steps] of SESSIONS) {
    let start = at(daysAgo, h, m);
    if (start.getTime() + min * 60_000 > now.getTime()) start = new Date(now.getTime() - (min + 15) * 60_000);
    const end = new Date(start.getTime() + min * 60_000);
    sessionSteps[daysAgo] = (sessionSteps[daysAgo] || 0) + steps;
    await db.query(
      `INSERT INTO sessions(id, user_id, type, started_at, ended_at, distance_km, steps, calories,
         avg_heart_rate, max_heart_rate, hr_samples, device_name)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FitPulse Band')`,
      [uuidv4(), userId, type, start, end, km || null, steps || null, kcal, avg, max, JSON.stringify(hrSamples(++n, avg, max))]
    );
  }

  // Lecturas del wearable: cada hora de 06:00 a 22:00 (hasta ahora en el día de hoy).
  // Los pasos de las lecturas completan el total diario junto con los de las sesiones.
  const rows = [];
  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    const hours = [];
    for (let h = 6; h <= 22; h++) {
      const t = at(daysAgo, h, 20);
      if (t < now) hours.push(t);
    }
    if (!hours.length) continue;
    const dayTotal = daysAgo < 7 ? WEEK_STEPS[6 - daysAgo] : 7800 + Math.round(r() * 2600);
    const fromWearable = Math.max(dayTotal - (sessionSteps[daysAgo] || 0), 0);
    const rest = RESTING[13 - daysAgo];
    const weights = hours.map(() => 0.5 + r());
    const sum = weights.reduce((a, b) => a + b, 0);
    let assigned = 0;
    hours.forEach((t, i) => {
      const steps = i === hours.length - 1 ? fromWearable - assigned : Math.round((fromWearable * weights[i]) / sum);
      assigned += steps;
      let hr = i === 0 ? rest : rest + 6 + Math.round(r() * 16);
      if (daysAgo === 0 && i === hours.length - 1) hr = 72;
      rows.push([deviceId, hr, Math.max(steps, 0), 96 + Math.round(r() * 3), t]);
    });
  }
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
  await db.query(`INSERT INTO metrics(device_id, heart_rate, steps, spo2, recorded_at) VALUES ${placeholders}`, rows.flat());

  // Metas
  const goals = [
    ['steps', '10,000 pasos diarios', 10000, 'pasos', 'daily', null],
    ['distance', 'Correr 15 km', 15, 'km', 'weekly', null],
    ['workouts', '4 entrenamientos', 4, 'entrenamientos', 'weekly', null],
    ['sleep', 'Dormir 8 horas', 8, 'horas', 'daily', 8],
  ];
  for (const [i, [type, title, target, unit, period, manual]] of goals.entries()) {
    await db.query(
      `INSERT INTO goals(id, user_id, type, title, target, unit, period, manual_value, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), userId, type, title, target, unit, period, manual, at(20, 9, i)]
    );
  }

  // Notificaciones
  const notices = [
    ['tip', 'Consejo de la semana', 'Caminar 10 minutos después de comer ayuda a mantener tu energía.', at(5, 9), true],
    ['battery', 'Batería baja', 'Tu FitPulse Band tenía 15%. Ya está cargada al 84%.', at(4, 21), true],
    ['heart', 'Ritmo cardíaco alto', 'Alcanzaste 176 bpm al correr. Recuerda hidratarte.', new Date(now.getTime() - 26 * 3600_000), true],
    ['sync', 'Dispositivo sincronizado', 'Se guardaron 3 sesiones nuevas desde tu FitPulse Band.', new Date(now.getTime() - 3600_000), false],
    ['goal', '¡Meta cumplida!', 'Llegaste a 10,000 pasos el sábado. ¡Sigue así!', new Date(now.getTime() - 2 * 60_000), false],
  ];
  for (const [kind, title, body, time, read] of notices) {
    await db.query(
      'INSERT INTO notifications(id, user_id, kind, title, body, read_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), userId, kind, title, body, read ? time : null, time]
    );
  }

  console.log(`Cuenta demo lista: ${EMAIL} / ${PASSWORD}`);
  console.log(`  ${SESSIONS.length} sesiones, ${goals.length} metas, ${rows.length} lecturas del wearable, ${notices.length} notificaciones`);
  await db.close();
}

main().catch(async err => {
  console.error('Seed failed:', err.message);
  await db.close();
  process.exit(1);
});
