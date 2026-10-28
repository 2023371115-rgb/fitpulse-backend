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

/** Responde 400 con el mensaje de validación, o 500 genérico en otros errores. */
function sendError(res, err, fallback, logLabel) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  console.error(logLabel || fallback, err.message);
  return res.status(500).json({ error: fallback });
}

module.exports = { ValidationError, optNumber, optInt, optText, sendError };
