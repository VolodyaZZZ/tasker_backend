import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { adminRoutes } from './admin.js';
import { authRoutes, requireRole } from './auth.js';
import { companyRoutes } from './company.js';
import { query } from './db.js';
import { publicRoutes } from './public.js';
import { uploadsDir, userRoutes } from './user.js';
import { HttpError } from './validation.js';

export const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use('/uploads', express.static(uploadsDir, { index: false, immutable: true, maxAge: '1d' }));
app.get('/api/health', async (_req, res) => {
  await query('SELECT 1');
  res.json({ status: 'ok' });
});
app.use('/api/auth', authRoutes);
app.get('/api/me', requireRole('user', 'company', 'admin'), (req, res) => res.json(req.account));
app.use('/api/user', requireRole('user'), userRoutes);
app.use('/api/company', requireRole('company'), companyRoutes);
app.use('/api/admin', requireRole('admin'), adminRoutes);
app.use('/api', publicRoutes);

app.use((_req, _res, next) => next(new HttpError(404, 'Resource not found')));
app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
  }
  if (error.status === 400 || error.status === 413) {
    return res.status(error.status).json({ error: error.status === 413 ? 'Request too large' : 'Invalid request body' });
  }
  if (error.code === '23505') return res.status(409).json({ error: 'Record already exists' });
  if (['22007', '22008', '23514'].includes(error.code)) {
    return res.status(400).json({ error: 'Invalid values or date range' });
  }
  console.error('Request failed', error.code ?? error.name);
  res.status(500).json({ error: 'Internal server error' });
});
