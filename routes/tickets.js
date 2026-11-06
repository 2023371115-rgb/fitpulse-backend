const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const { notify } = require('../services/notify');
const { optText, sendError, ValidationError } = require('../services/validate');

/**
 * Reportes de fallos (tickets).
 * El usuario los crea desde la app o la web; el administrador los atiende en /api/admin/tickets.
 */
const router = express.Router();
router.use(authMiddleware);

const CATEGORIES = ['bug', 'crash', 'ui', 'performance', 'data', 'other'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

const STATUS_LABEL = { open: 'Abierto', in_progress: 'En revisión', resolved: 'Resuelto', closed: 'Cerrado' };

const FIELDS = `t.id, t.folio, t.user_id, t.title, t.description, t.category, t.severity, t.status,
  t.screen, t.platform, t.app_version, t.device_info, t.admin_note, t.created_at, t.updated_at, t.resolved_at`;

/** "FP-0007" — folio legible para mostrar al usuario. */
function shape(row) {
  return { ...row, code: `FP-${String(row.folio).padStart(4, '0')}`, status_label: STATUS_LABEL[row.status] };
}

function pick(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (!allowed.includes(v)) throw new ValidationError(`${field} debe ser: ${allowed.join(', ')}`);
  return v;
}

function readTicketBody(body = {}) {
  const title = optText(body.title, 'title', 140);
  const description = optText(body.description, 'description', 4000);
  if (!title || title.length < 3) throw new ValidationError('Escribe un título de al menos 3 caracteres');
  if (!description || description.length < 10) throw new ValidationError('Describe el fallo con al menos 10 caracteres');
  return {
    title,
    description,
    category: pick(body.category, CATEGORIES, 'category', 'bug'),
    severity: pick(body.severity, SEVERITIES, 'severity', 'medium'),
    screen: optText(body.screen, 'screen', 80),
    platform: optText(body.platform, 'platform', 40),
    app_version: optText(body.app_version, 'app_version', 40),
    device_info: optText(body.device_info, 'device_info', 255),
  };
}

async function findTicket(id) {
  const r = await query(`SELECT ${FIELDS} FROM tickets t WHERE t.id = ?`, [id]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

// POST /api/tickets — reportar un fallo
router.post('/', async (req, res) => {
  try {
    const t = readTicketBody(req.body);
    const id = uuidv4();
    await query(
      `INSERT INTO tickets(id, user_id, title, description, category, severity, screen, platform, app_version, device_info)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, t.title, t.description, t.category, t.severity, t.screen, t.platform, t.app_version, t.device_info]
    );
    const ticket = await findTicket(id);
    await notify(req.user.id, 'ticket', `Reporte ${ticket.code} recibido`, `Gracias. Revisaremos "${ticket.title}".`);
    return res.status(201).json({ ticket });
  } catch (err) {
    return sendError(res, err, 'No se pudo guardar el reporte', 'ticket create error');
  }
});

// GET /api/tickets?status=open — mis reportes, más recientes primero
router.get('/', async (req, res) => {
  try {
    const params = [req.user.id];
    let filter = '';
    if (req.query.status) {
      filter = ' AND t.status = ?';
      params.push(pick(req.query.status, STATUSES, 'status'));
    }
    const r = await query(`SELECT ${FIELDS} FROM tickets t WHERE t.user_id = ?${filter} ORDER BY t.created_at DESC LIMIT 200`, params);
    return res.json({ items: r.rows.map(shape) });
  } catch (err) {
    return sendError(res, err, 'No se pudieron cargar los reportes', 'ticket list error');
  }
});

// GET /api/tickets/:id — detalle de un reporte propio
router.get('/:id', async (req, res) => {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket || ticket.user_id !== req.user.id) return res.status(404).json({ error: 'Reporte no encontrado' });
    return res.json({ ticket });
  } catch (err) {
    return sendError(res, err, 'No se pudo cargar el reporte', 'ticket get error');
  }
});

// ───────── Administración (se monta en /api/admin/tickets) ─────────
const admin = express.Router();

// GET /api/admin/tickets?status=open&severity=high
admin.get('/', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.status) { where.push('t.status = ?'); params.push(pick(req.query.status, STATUSES, 'status')); }
    if (req.query.severity) { where.push('t.severity = ?'); params.push(pick(req.query.severity, SEVERITIES, 'severity')); }
    const r = await query(
      `SELECT ${FIELDS}, u.email AS user_email, u.name AS user_name
       FROM tickets t LEFT JOIN users u ON u.id = t.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY FIELD(t.status,'open','in_progress','resolved','closed'),
                FIELD(t.severity,'critical','high','medium','low'), t.created_at DESC
       LIMIT 500`,
      params
    );
    const counts = await query('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status');
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const c of counts.rows) byStatus[c.status] = Number(c.n);
    return res.json({ items: r.rows.map(shape), counts: byStatus });
  } catch (err) {
    return sendError(res, err, 'No se pudieron cargar los reportes', 'admin ticket list error');
  }
});

// PATCH /api/admin/tickets/:id — { status?, admin_note?, severity? }
admin.patch('/:id', async (req, res) => {
  try {
    const before = await findTicket(req.params.id);
    if (!before) return res.status(404).json({ error: 'Reporte no encontrado' });
    const status = pick(req.body?.status, STATUSES, 'status', before.status);
    const severity = pick(req.body?.severity, SEVERITIES, 'severity', before.severity);
    const note = req.body?.admin_note === undefined ? before.admin_note : optText(req.body.admin_note, 'admin_note', 2000);
    const resolvedAt = ['resolved', 'closed'].includes(status) ? (before.resolved_at || new Date()) : null;
    await query('UPDATE tickets SET status = ?, severity = ?, admin_note = ?, resolved_at = ? WHERE id = ?',
      [status, severity, note, resolvedAt, before.id]);
    const ticket = await findTicket(before.id);
    if (status !== before.status && ticket.user_id) {
      await notify(ticket.user_id, 'ticket', `Reporte ${ticket.code}: ${STATUS_LABEL[status]}`,
        note ? `"${ticket.title}". Nota: ${note}` : `"${ticket.title}" cambió a ${STATUS_LABEL[status].toLowerCase()}.`);
    }
    return res.json({ ticket });
  } catch (err) {
    return sendError(res, err, 'No se pudo actualizar el reporte', 'admin ticket update error');
  }
});

module.exports = router;
module.exports.admin = admin;
module.exports.CATEGORIES = CATEGORIES;
module.exports.SEVERITIES = SEVERITIES;
module.exports.STATUSES = STATUSES;
