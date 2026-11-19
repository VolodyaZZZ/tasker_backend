import { mkdir } from 'node:fs/promises';
import { app } from './app.js';
import { pool } from './db.js';
import { uploadsDir } from './user.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (Buffer.byteLength(process.env.JWT_SECRET ?? '') < 32 || process.env.JWT_SECRET.startsWith('replace-with-')) {
  throw new Error('Set JWT_SECRET to a random secret of at least 32 bytes');
}

await pool.query('SELECT 1 FROM v_company_stats LIMIT 0');
await mkdir(uploadsDir, { recursive: true });
const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`Tasker API listening on port ${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => pool.end()));
}
