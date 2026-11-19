import bcrypt from 'bcryptjs';
import { pool, query } from './db.js';
import { email, password, string } from './validation.js';

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
  const address = email(ADMIN_EMAIL);
  const name = string(ADMIN_NAME, 'ADMIN_NAME', 150);
  const hash = await bcrypt.hash(password(ADMIN_PASSWORD), 12);
  await query("INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, $2, $3, 'admin')", [
    address, name, hash
  ]);
  console.log('Administrator created');
} catch (error) {
  console.error(error.code === '23505' ? 'Email already exists' : error.code ?? error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
