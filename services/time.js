/**
 * Utilidades de fechas. La base de datos guarda todo en UTC y cada cliente
 * envía su desfase horario en minutos (encabezado X-Timezone-Offset o ?tz=),
 * por ejemplo -360 para Ciudad de México. Así "hoy" y "esta semana" se
 * calculan con el día local del usuario.
 */

const DAY_MS = 86_400_000;
const MAX_OFFSET = 14 * 60;

function tzOffset(req) {
  const raw = req.headers['x-timezone-offset'] ?? req.query.tz;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(n)));
}

/** Instante UTC en que empieza el día local que contiene `date`. */
function startOfLocalDay(date, offsetMin) {
  const local = new Date(date.getTime() + offsetMin * 60_000);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnightLocal - offsetMin * 60_000);
}

/** Inicio de la semana local (lunes 00:00). */
function startOfLocalWeek(date, offsetMin) {
  const day = startOfLocalDay(date, offsetMin);
  const local = new Date(day.getTime() + offsetMin * 60_000);
  const weekday = (local.getUTCDay() + 6) % 7; // 0 = lunes
  return new Date(day.getTime() - weekday * DAY_MS);
}

/** Fecha local YYYY-MM-DD de un instante. */
function localDateKey(date, offsetMin) {
  return new Date(date.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** Ventana [from, to) del periodo que contiene `now`, desplazada `back` periodos atrás. */
function periodWindow(period, now, offsetMin, back = 0) {
  if (period === 'weekly') {
    const from = new Date(startOfLocalWeek(now, offsetMin).getTime() - back * 7 * DAY_MS);
    return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
  }
  const from = new Date(startOfLocalDay(now, offsetMin).getTime() - back * DAY_MS);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

/** Convierte un valor recibido en la API a Date válida o null. */
function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { DAY_MS, tzOffset, startOfLocalDay, startOfLocalWeek, localDateKey, periodWindow, parseDate };
