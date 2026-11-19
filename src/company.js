import { Router } from 'express';
import { query, transaction } from './db.js';
import { HttpError, first, id, optional, page, string } from './validation.js';

export const companyRoutes = Router();

function promotionBody(body = {}) {
  const source = string(body.source_url, 'source_url', 2048);
  const url = URL.parse(source);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, 'Source URL must use HTTP or HTTPS');
  }
  const dates = ['starts_at', 'ends_at'].map((field) => {
    const value = optional(body[field], field, 50);
    if (value === null) return null;
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new HttpError(400, `Invalid ${field}; use ISO 8601 with a timezone`);
    }
    return value;
  });
  return [
    string(body.title, 'title', 200), string(body.description, 'description', 10000),
    optional(body.conditions, 'conditions', 10000), optional(body.address, 'address', 500), url.href, ...dates
  ];
}

function changePromotion(req, work) {
  return transaction(async (client) => {
    const company = first(await client.query('SELECT status FROM companies WHERE id = $1 FOR NO KEY UPDATE', [req.account.id]));
    if (company.status === 'blocked') throw new HttpError(403, 'Account blocked');
    return work(client, company.status);
  });
}

companyRoutes.get('/dashboard', async (req, res) => {
  const [stats, promotions, reviews] = await Promise.all([
    query('SELECT rating, review_count, approved_report_count FROM v_company_stats WHERE company_id = $1', [req.account.id]),
    query('SELECT * FROM promotions WHERE company_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3', [req.account.id, ...page(req.query)]),
    query('SELECT * FROM v_reviews WHERE company_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10', [req.account.id])
  ]);
  res.json({ company: req.account, ...first(stats), report_block_threshold: 3, promotions: promotions.rows, recent_reviews: reviews.rows });
});

companyRoutes.post('/promotions', async (req, res) => {
  const values = promotionBody(req.body ?? {});
  const result = await changePromotion(req, (client) => client.query(
    `INSERT INTO promotions (company_id, title, description, conditions, address, source_url, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [req.account.id, ...values]
  ));
  res.status(201).json(first(result));
});

companyRoutes.get('/promotions/:id', async (req, res) => {
  res.json(first(await query('SELECT * FROM promotions WHERE id = $1 AND company_id = $2', [
    id(req.params.id), req.account.id
  ])));
});

companyRoutes.put('/promotions/:id', async (req, res) => {
  const values = promotionBody(req.body ?? {});
  const result = await changePromotion(req, (client) => client.query(
    `UPDATE promotions SET title = $3, description = $4, conditions = $5, address = $6,
       source_url = $7, starts_at = $8, ends_at = $9, status = 'draft'
     WHERE id = $1 AND company_id = $2 AND status IN ('draft', 'pending', 'approved', 'rejected')
     RETURNING *`, [id(req.params.id), req.account.id, ...values]
  ));
  res.json(first(result));
});

companyRoutes.post('/promotions/:id/submit', async (req, res) => {
  const result = await changePromotion(req, (client, companyStatus) => {
    if (companyStatus !== 'approved') throw new HttpError(403, 'Company approval required');
    return client.query(
      `UPDATE promotions SET status = 'pending' WHERE id = $1 AND company_id = $2
       AND status IN ('draft', 'rejected') RETURNING *`, [id(req.params.id), req.account.id]
    );
  });
  res.json(first(result));
});

companyRoutes.post('/promotions/:id/finish', async (req, res) => {
  const result = await changePromotion(req, (client) => client.query(
    `UPDATE promotions SET status = 'finished' WHERE id = $1 AND company_id = $2
     AND status = 'approved' RETURNING *`, [id(req.params.id), req.account.id]
  ));
  res.json(first(result));
});

companyRoutes.delete('/promotions/:id', async (req, res) => {
  const result = await changePromotion(req, (client) => client.query(
    "UPDATE promotions SET status = 'hidden' WHERE id = $1 AND company_id = $2 RETURNING id",
    [id(req.params.id), req.account.id]
  ));
  first(result);
  res.sendStatus(204);
});
