import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { query, transaction } from './db.js';
import { publicPromotion } from './public.js';
import { HttpError, choice, first, id, page, rating, string } from './validation.js';

export const userRoutes = Router();
export const uploadsDir = resolve(process.env.UPLOADS_DIR || 'uploads');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, fieldSize: 12000 }
});
const reportReasons = [
  'impossible_requirements', 'personal_data_collection', 'suspected_fraud',
  'branch_closed_or_missing', 'wrong_reward_info', 'other'
];

userRoutes.get('/dashboard', async (req, res) => {
  const pagination = [req.account.id, ...page(req.query)];
  const [activity, reports, counts] = await Promise.all([
    query(`SELECT pt.id AS participation_id, pt.joined_at, pt.promotion_id, p.title AS promotion_title,
                  r.id AS review_id, r.rating, r.comment, r.photo_path
           FROM participations pt JOIN promotions p ON p.id = pt.promotion_id
           LEFT JOIN reviews r ON r.participation_id = pt.id
           WHERE pt.user_id = $1 ORDER BY pt.joined_at DESC, pt.id DESC LIMIT $2 OFFSET $3`, pagination),
    query(`SELECT id, promotion_id, reason_type, description, status, admin_comment, created_at, resolved_at
           FROM reports WHERE reporter_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`, pagination),
    query(`SELECT count(*)::integer AS participation_count, count(r.id)::integer AS review_count,
                  (SELECT count(*)::integer FROM reports WHERE reporter_id = $1) AS report_count
           FROM participations pt LEFT JOIN reviews r ON r.participation_id = pt.id WHERE pt.user_id = $1`, [req.account.id])
  ]);
  res.json({ user: req.account, ...first(counts), activity: activity.rows, reports: reports.rows });
});

async function lockPublicPromotion(client, promotionId, startedOnly) {
  first(await client.query(
    `SELECT c.id FROM companies c
     WHERE c.status = 'approved' AND c.id = (SELECT company_id FROM promotions WHERE id = $1)
     FOR SHARE`, [promotionId]
  ));
  first(await client.query(
    `SELECT p.id FROM promotions p JOIN companies c ON c.id = p.company_id
     WHERE p.id = $1 AND ${publicPromotion}
       AND (NOT $2::boolean OR p.starts_at IS NULL OR p.starts_at <= now())
     FOR SHARE OF p`, [promotionId, startedOnly]
  ));
}

userRoutes.post('/promotions/:id/reviews', upload.single('photo'), async (req, res) => {
  const promotionId = id(req.params.id);
  const score = rating(req.body?.rating);
  const comment = string(req.body?.comment, 'comment', 3000);
  if (!req.file) throw new HttpError(400, 'Participation photo is required');

  const photo = sharp(req.file.buffer, { limitInputPixels: 20000000 });
  let image;
  try {
    const metadata = await photo.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error();
    image = await photo.rotate().resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
  } catch {
    throw new HttpError(400, 'Photo must be a valid JPG, PNG or WebP image');
  }

  const filename = `${randomUUID()}.webp`;
  const path = join(uploadsDir, filename);
  let photoWritten = false;
  const result = await transaction(async (client) => {
    await lockPublicPromotion(client, promotionId, true);
    const values = [req.account.id, promotionId];
    await client.query(
      `INSERT INTO participations (user_id, promotion_id) VALUES ($1, $2)
       ON CONFLICT (user_id, promotion_id) DO NOTHING`, values
    );
    const review = first(await client.query(
      `INSERT INTO reviews (participation_id, rating, comment, photo_path)
       SELECT id, $3, $4, $5 FROM participations WHERE user_id = $1 AND promotion_id = $2 RETURNING *`,
      [...values, score, comment, `/uploads/${filename}`]
    ));
    await writeFile(path, image, { flag: 'wx' });
    photoWritten = true;
    return review;
  }).catch(async (error) => {
    if (photoWritten) await unlink(path).catch(() => {});
    throw error;
  });
  res.status(201).json(result);
});

userRoutes.post('/promotions/:id/reports', async (req, res) => {
  const promotionId = id(req.params.id);
  const body = req.body ?? {};
  const reason = choice(body.reason_type, 'reason_type', reportReasons);
  const description = string(body.description, 'description', 5000, 10);
  const report = await transaction(async (client) => {
    await lockPublicPromotion(client, promotionId, false);
    return first(await client.query(
      `INSERT INTO reports (promotion_id, reporter_id, reason_type, description)
       VALUES ($1, $2, $3, $4) RETURNING *`, [promotionId, req.account.id, reason, description]
    ));
  });
  res.status(201).json(report);
});
