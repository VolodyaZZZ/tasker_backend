import { Router } from 'express';
import { query, transaction } from './db.js';
import { HttpError, choice, first, id, page, string } from './validation.js';

export const adminRoutes = Router();

adminRoutes.get('/dashboard', async (_req, res) => {
  res.json(first(await query(
    `SELECT (SELECT count(*)::integer FROM companies WHERE status = 'pending') AS pending_companies,
            (SELECT count(*)::integer FROM promotions WHERE status = 'pending') AS pending_promotions,
            (SELECT count(*)::integer FROM reports WHERE status = 'open') AS open_reports,
            (SELECT count(*)::integer FROM users WHERE role = 'user' AND is_blocked) AS blocked_users`
  )));
});

const queues = {
  companies: {
    statuses: ['pending', 'approved', 'rejected', 'blocked'],
    sql: `SELECT c.id, c.name, c.bin, c.email, c.contact_phone, c.status,
                 s.rating, s.review_count, s.approved_report_count
          FROM companies c JOIN v_company_stats s ON s.company_id = c.id WHERE c.status = $1`
  },
  promotions: {
    statuses: ['pending', 'draft', 'approved', 'rejected', 'hidden', 'finished'],
    sql: 'SELECT p.*, c.name AS company_name FROM promotions p JOIN companies c ON c.id = p.company_id WHERE p.status = $1'
  },
  reports: {
    statuses: ['open', 'approved', 'rejected'],
    sql: `SELECT r.*, p.title AS promotion_title, p.company_id, c.name AS company_name, s.approved_report_count
          FROM reports r JOIN promotions p ON p.id = r.promotion_id JOIN companies c ON c.id = p.company_id
          JOIN v_company_stats s ON s.company_id = c.id WHERE r.status = $1`
  }
};

for (const [name, { statuses, sql }] of Object.entries(queues)) {
  adminRoutes.get(`/${name}`, async (req, res) => {
    const status = choice(req.query.status ?? statuses[0], 'status', statuses);
    const { rows } = await query(`${sql} ORDER BY id DESC LIMIT $2 OFFSET $3`, [status, ...page(req.query)]);
    res.json(rows);
  });
}

adminRoutes.get('/users', async (req, res) => {
  const { rows } = await query(
    "SELECT id, email, full_name, phone, is_blocked FROM users WHERE role = 'user' ORDER BY id DESC LIMIT $1 OFFSET $2",
    page(req.query)
  );
  res.json(rows);
});

adminRoutes.patch('/users/:id', async (req, res) => {
  const blocked = req.body?.is_blocked;
  if (typeof blocked !== 'boolean') throw new HttpError(400, 'is_blocked must be a boolean');
  res.json(first(await query(
    "UPDATE users SET is_blocked = $2 WHERE id = $1 AND role = 'user' RETURNING id, is_blocked",
    [id(req.params.id), blocked]
  )));
});

adminRoutes.patch('/companies/:id/status', async (req, res) => {
  const status = choice(req.body?.status, 'status', ['approved', 'rejected', 'blocked']);
  res.json(first(await query(
    `UPDATE companies SET status = $2::company_status WHERE id = $1 AND
       (status = 'pending' OR ($2::company_status = 'blocked' AND status IN ('approved', 'rejected'))) RETURNING id, status`,
    [id(req.params.id), status]
  )));
});

adminRoutes.patch('/promotions/:id/status', async (req, res) => {
  const promotion = id(req.params.id);
  const status = choice(req.body?.status, 'status', ['approved', 'rejected', 'hidden']);
  const result = await transaction(async (client) => {
    const company = first(await client.query(
      'SELECT status FROM companies WHERE id = (SELECT company_id FROM promotions WHERE id = $1) FOR NO KEY UPDATE',
      [promotion]
    ));
    if (status === 'approved' && company.status !== 'approved') throw new HttpError(409, 'Company approval required');
    return first(await client.query(
      `UPDATE promotions SET status = $2::promotion_status
       WHERE id = $1 AND (status = 'pending' OR ($2::promotion_status = 'hidden' AND status IN ('approved', 'finished')))
       RETURNING id, status`, [promotion, status]
    ));
  });
  res.json(result);
});

adminRoutes.patch('/reports/:id/resolve', async (req, res) => {
  const reportId = id(req.params.id);
  const status = choice(req.body?.status, 'status', ['approved', 'rejected']);
  const comment = string(req.body?.admin_comment, 'admin_comment', 5000);
  res.json(first(await query(
    `UPDATE reports SET status = $2, admin_comment = $3, resolved_by = $4, resolved_at = now()
     WHERE id = $1 AND status = 'open' RETURNING *`, [reportId, status, comment, req.account.id]
  )));
});
