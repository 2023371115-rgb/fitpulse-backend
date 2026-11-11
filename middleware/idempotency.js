/**
 * Práctica 12 · Idempotencia para escrituras que la app puede reintentar.
 *
 * Problema (RES-07 / RES-08): si el servidor guarda una sesión o un reporte pero la respuesta
 * no llega al teléfono (timeout, se cae la red), la app muestra error y el usuario vuelve a
 * presionar "Guardar": se crea un registro duplicado.
 *
 * Solución: la app manda `Idempotency-Key: <clave única por operación>` y repite la MISMA clave
 * en cada reintento. Aquí:
 *  1. Se intenta INSERTAR la clave (usuario, clave) con status NULL = "en proceso".
 *     La llave primaria hace que solo una solicitud gane, aunque lleguen varias a la vez.
 *  2. Si la clave ya existía:
 *       - con otra solicitud distinta (otro cuerpo/ruta) → 422;
 *       - todavía en proceso → 409 { code: 'IDEMPOTENCY_IN_PROGRESS' } (la app espera y reintenta);
 *       - ya terminada → se devuelve la respuesta guardada, con `Idempotent-Replayed: true`,
 *         sin volver a ejecutar la ruta (no hay duplicado).
 *  3. Al responder, la ruta guarda su código y cuerpo. Si falló con 5xx (o no llegó a responder)
 *     la clave se borra para que un reintento pueda volver a intentarlo de verdad.
 * Sin el encabezado, la ruta funciona igual que antes (compatibilidad con la web y scripts).
 */
const crypto = require('crypto');
const { query } = require('../db');

const VALID_KEY = /^[A-Za-z0-9_-]{8,80}$/;
const TTL_HOURS = 24;

function hashRequest(req) {
  return crypto.createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
}

async function idempotent(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (!key) return next();
  if (!VALID_KEY.test(key)) return res.status(400).json({ error: 'Idempotency-Key no válida (8 a 80 letras, números, - o _)' });
  if (!req.user?.id) return next();

  const userId = req.user.id;
  const route = `${req.baseUrl}${req.path}`.slice(0, 120);
  const hash = hashRequest(req);
  try {
    await query('INSERT INTO idempotency_keys (user_id, idem_key, method, path, request_hash) VALUES (?, ?, ?, ?, ?)',
      [userId, key, req.method, route, hash]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') return next(err);
    const r = await query('SELECT method, path, request_hash, status, response FROM idempotency_keys WHERE user_id = ? AND idem_key = ?', [userId, key]);
    const row = r.rows[0];
    if (!row) return res.status(409).set('Retry-After', '1').json({ error: 'La solicitud anterior se está procesando', code: 'IDEMPOTENCY_IN_PROGRESS' });
    if (row.request_hash !== hash) {
      return res.status(422).json({ error: 'Esta Idempotency-Key ya se usó con una solicitud diferente', code: 'IDEMPOTENCY_MISMATCH' });
    }
    if (row.status == null) {
      return res.status(409).set('Retry-After', '1').json({ error: 'La solicitud anterior se está procesando', code: 'IDEMPOTENCY_IN_PROGRESS' });
    }
    res.set('Idempotent-Replayed', 'true');
    return res.status(Number(row.status)).type('application/json').send(row.response ?? '');
  }

  // Limpieza ocasional de claves viejas (≈1 de cada 50 escrituras con clave)
  if (Math.random() < 0.02) {
    query(`DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL ${TTL_HOURS} HOUR`).catch(() => {});
  }

  let settled = false;
  const forget = () => query('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ? AND status IS NULL', [userId, key]).catch(() => {});
  const originalJson = res.json.bind(res);
  res.json = body => {
    if (!settled) {
      settled = true;
      if (res.statusCode >= 500) forget();
      else {
        // Se guarda antes de enviar: un reintento que llegue justo después ya encuentra la respuesta.
        query('UPDATE idempotency_keys SET status = ?, response = ? WHERE user_id = ? AND idem_key = ?',
          [res.statusCode, JSON.stringify(body), userId, key]).catch(err => console.error('idempotency save error', err.message));
      }
    }
    return originalJson(body);
  };
  res.on('close', () => { if (!settled) { settled = true; forget(); } });
  return next();
}

module.exports = { idempotent, hashRequest };
