/**
 * Práctica 12 · Caché del índice de búsqueda por usuario.
 *
 * Antes, cada GET /api/search hacía 5 consultas y reconstruía el índice invertido completo
 * (tokenizar, quitar acentos, sacar raíces de ~900 documentos). Eso es trabajo de CPU en el
 * hilo único de Node: con 5 usuarios a la vez el servidor ya no pasaba de ~22 búsquedas/s.
 *
 * Ahora el índice se construye una vez y se reutiliza mientras los datos no cambien:
 *  - Se invalida en cuanto hay una escritura con éxito (POST/PUT/PATCH/DELETE):
 *    · reportes, usuarios, perfil y administración (/api/tickets, /api/admin, /api/auth/register, /api/profile)
 *      vacían todo el caché, porque el índice de los administradores ve reportes y usuarios de
 *      todos, y un administrador que cambia un reporte afecta el índice de su dueño;
 *    · el resto (sesiones, metas, dispositivos, notificaciones) solo borra el índice de quien escribió.
 *  - TTL de 30 s como red de seguridad para cambios que no pasan por una solicitud
 *    (p. ej. la limpieza periódica de services/retention.js).
 *  - Máximo 50 índices en memoria (LRU): los menos usados se descartan primero.
 *  - Se guarda la promesa, no el resultado: si llegan 10 búsquedas a la vez sin caché,
 *    el índice se construye una sola vez (sin "estampida").
 */
const TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 30000);
const MAX_ENTRIES = Number(process.env.SEARCH_CACHE_MAX || 50);

const entries = new Map(); // clave → { promise, at, admin }
const stats = { hits: 0, misses: 0, invalidations: 0 };

const key = (userId, isAdmin) => `${isAdmin ? 'a' : 'u'}:${userId}`;

function get(userId, isAdmin, build, now = Date.now()) {
  const k = key(userId, isAdmin);
  const e = entries.get(k);
  if (e && now - e.at < TTL_MS) {
    entries.delete(k); entries.set(k, e); // al final = usado más recientemente
    stats.hits++;
    return e.promise;
  }
  stats.misses++;
  const entry = { at: now, admin: isAdmin, promise: null };
  entry.promise = Promise.resolve().then(build).catch(err => {
    if (entries.get(k) === entry) entries.delete(k); // no guardar errores
    throw err;
  });
  entries.set(k, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  return entry.promise;
}

/** Los datos de `userId` cambiaron: se descarta su índice (normal y de administrador). */
function invalidate(userId) {
  stats.invalidations++;
  entries.delete(key(userId, false));
  entries.delete(key(userId, true));
}

// /api/auth/login no cambia datos, por eso solo cuenta el registro.
const GLOBAL_PREFIXES = ['/api/tickets', '/api/admin', '/api/auth/register', '/api/profile'];

/**
 * Middleware: después de cada escritura exitosa invalida el caché que corresponda.
 * Se monta antes de las rutas; req.user lo llena authMiddleware dentro de cada router, y el
 * evento 'finish' ocurre después, cuando ya está disponible.
 */
function invalidateOnWrite(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    const url = req.originalUrl;
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      if (GLOBAL_PREFIXES.some(p => url.startsWith(p))) { stats.invalidations++; entries.clear(); }
      else if (req.user?.id) invalidate(req.user.id);
    });
  }
  next();
}

function clear() { entries.clear(); }

module.exports = { get, invalidate, invalidateOnWrite, clear, stats, size: () => entries.size, TTL_MS };
