import { Router } from 'express';
import { query } from './db.js';
import { first, id, optional, page } from './validation.js';

export const publicRoutes = Router();

export const publicPromotion = `c.status = 'approved' AND p.status IN ('approved', 'finished')`;
const promotionDetails = 'p.*, c.name AS company_name, s.rating, s.review_count';

publicRoutes.get('/promotions', async (req, res) => {
  const search = optional(req.query.q, 'q', 200);
  const company = req.query.company_id === undefined ? null : id(req.query.company_id);
  const { rows } = await query(
    `SELECT ${promotionDetails} FROM promotions p JOIN companies c ON c.id = p.company_id
     JOIN v_company_stats s ON s.company_id = c.id
     WHERE c.status = 'approved' AND p.status = 'approved'
       AND (p.starts_at IS NULL OR p.starts_at <= now()) AND (p.ends_at IS NULL OR p.ends_at > now())
       AND ($1::text IS NULL OR strpos(lower(p.title), lower($1)) > 0)
       AND ($2::int IS NULL OR p.company_id = $2)
     ORDER BY p.id DESC LIMIT $3 OFFSET $4`, [search, company, ...page(req.query)]
  );
  res.json(rows);
});

publicRoutes.get('/promotions/:id', async (req, res) => {
  res.json(first(await query(
    `SELECT ${promotionDetails} FROM promotions p JOIN companies c ON c.id = p.company_id
     JOIN v_company_stats s ON s.company_id = c.id
     WHERE p.id = $1 AND ${publicPromotion}`, [id(req.params.id)]
  )));
});

publicRoutes.get('/companies/:id', async (req, res) => {
  res.json(first(await query(
    `SELECT c.id, c.name, c.bin, c.contact_phone, s.rating, s.review_count
     FROM companies c JOIN v_company_stats s ON s.company_id = c.id
     WHERE c.id = $1 AND c.status = 'approved'`, [id(req.params.id)]
  )));
});

for (const [resource, key] of [['promotions', 'promotion_id'], ['companies', 'company_id']]) {
  publicRoutes.get(`/${resource}/:id/reviews`, async (req, res) => {
    const { rows } = await query(
      `SELECT r.id, r.rating, r.comment, r.photo_path, r.created_at, r.author_name, r.promotion_id, r.promotion_title
       FROM v_reviews r JOIN promotions p ON p.id = r.promotion_id JOIN companies c ON c.id = r.company_id
       WHERE r.${key} = $1 AND ${publicPromotion}
       ORDER BY r.created_at DESC, r.id DESC LIMIT $2 OFFSET $3`, [id(req.params.id), ...page(req.query)]
    );
    res.json(rows);
  });
}
