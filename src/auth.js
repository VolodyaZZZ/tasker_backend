import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from './db.js';
import { HttpError, bin, choice, email, optional, password, string } from './validation.js';

const selectUser = 'id, email, role, full_name, phone, is_blocked';
const selectCompany = 'id, email, name, bin, contact_phone, status';
const dummyHash = bcrypt.hashSync('invalid-account-password', 12);

export const authRoutes = Router();

function session(account, role) {
  return {
    token: jwt.sign({ role }, process.env.JWT_SECRET, {
      algorithm: 'HS256', subject: String(account.id), expiresIn: '2h', issuer: 'tasker'
    }),
    account: { ...account, role }
  };
}

authRoutes.post('/register/user', async (req, res) => {
  const body = req.body ?? {};
  const values = [email(body.email), string(body.full_name, 'full_name', 150), optional(body.phone, 'phone', 20)];
  const hash = await bcrypt.hash(password(body.password), 12);
  const { rows: [account] } = await query(
    `INSERT INTO users (email, full_name, phone, password_hash)
     VALUES ($1, $2, $3, $4) RETURNING ${selectUser}`, [...values, hash]
  );
  res.status(201).json(session(account, 'user'));
});

authRoutes.post('/register/company', async (req, res) => {
  const body = req.body ?? {};
  const values = [
    email(body.email), string(body.name, 'name', 200), bin(body.bin),
    optional(body.contact_phone, 'contact_phone', 20)
  ];
  const hash = await bcrypt.hash(password(body.password), 12);
  const { rows: [account] } = await query(
    `INSERT INTO companies (email, name, bin, contact_phone, password_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${selectCompany}`, [...values, hash]
  );
  res.status(201).json(session(account, 'company'));
});

authRoutes.post('/login', async (req, res) => {
  const body = req.body ?? {};
  const role = choice(body.role, 'role', ['user', 'admin', 'company']);
  const address = email(body.email);
  const secret = password(body.password);
  const { rows: [record] } = role === 'company'
    ? await query(`SELECT ${selectCompany}, password_hash FROM companies WHERE email = $1`, [address])
    : await query(`SELECT ${selectUser}, password_hash FROM users WHERE email = $1 AND role = $2`, [address, role]);

  const valid = await bcrypt.compare(secret, record?.password_hash ?? dummyHash);
  if (!record || !valid) throw new HttpError(401, 'Invalid credentials');
  const { password_hash, ...account } = record;
  if (account.is_blocked || account.status === 'blocked') throw new HttpError(403, 'Account blocked');
  res.json(session(account, role));
});

export function requireRole(...roles) {
  return async (req, res, next) => {
    const header = req.get('authorization') ?? '';
    let claims;
    try {
      if (!header.startsWith('Bearer ')) throw new Error();
      claims = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'tasker' });
    } catch {
      throw new HttpError(401, 'Invalid or missing token');
    }
    if (!roles.includes(claims.role)) throw new HttpError(403, 'Access denied');
    const { rows: [account] } = claims.role === 'company'
      ? await query(`SELECT ${selectCompany} FROM companies WHERE id = $1`, [claims.sub])
      : await query(`SELECT ${selectUser} FROM users WHERE id = $1 AND role = $2`, [claims.sub, claims.role]);
    if (!account) throw new HttpError(401, 'Account unavailable');
    if (account.is_blocked || account.status === 'blocked') throw new HttpError(403, 'Account blocked');
    req.account = { ...account, role: claims.role };
    next();
  };
}
