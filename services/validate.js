/** Validaciones simples y reutilizables para la API. */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Número opcional dentro de un rango. Devuelve null si viene vacío. */
function optNumber(value, field, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${field} debe estar entre ${min} y ${max}`);
  }
  return n;
}

function optInt(value, field, min, max) {
  const n = optNumber(value, field, min, max);
  return n === null ? null : Math.round(n);
}

/** Texto opcional, recortado y con longitud máxima. */
function optText(value, field, max) {
  if (value === undefined || value === null) return null;
  const t = String(value).trim();
  if (t.length > max) throw new ValidationError(`${field} admite máximo ${max} caracteres`);
  return t || null;
}

/**
 * Entero para parámetros como ?limit= y ?size=: descarta los decimales y lo deja en [min, max].
 * Vacío, 0 o un valor que no es número usan el valor por defecto. Así el resultado siempre
 * es un entero seguro para LIMIT (antes ?limit=5.5 llegaba tal cual al SQL y daba error 500).
 */
function intParam(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n === 0) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Responde 400 con el mensaje de validación, o 500 genérico en otros errores. */
function sendError(res, err, fallback, logLabel) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  console.error(logLabel || fallback, err.message);
  return res.status(500).json({ error: fallback });
}

module.exports = { ValidationError, optNumber, optInt, optText, intParam, sendError };
