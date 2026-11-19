export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function string(value, name, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || value.includes('\0')) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return value.trim();
}

export function optional(value, name, max) {
  return value == null || value === '' ? null : string(value, name, max);
}

export function email(value) {
  const result = string(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'Invalid email');
  return result;
}

export function password(value) {
  if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value) > 72) {
    throw new HttpError(400, 'Password must have at least 8 characters and at most 72 UTF-8 bytes');
  }
  return value;
}

export function id(value) {
  const result = Number(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value) || result < 1 || result > 2147483647) {
    throw new HttpError(400, 'Invalid id');
  }
  return result;
}

export function page(params) {
  const limit = params.limit === undefined ? 20 : id(params.limit);
  const offset = params.offset === undefined || params.offset === '0' ? 0 : id(params.offset);
  if (limit > 100) throw new HttpError(400, 'Limit must be at most 100');
  return [limit, offset];
}

export function choice(value, name, options) {
  if (!options.includes(value)) throw new HttpError(400, `Invalid ${name}`);
  return value;
}

export function rating(value) {
  if (typeof value !== 'string' || !/^[1-5]$/.test(value)) {
    throw new HttpError(400, 'Rating must be an integer from 1 to 5');
  }
  return Number(value);
}

export function bin(value) {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value)) throw new HttpError(400, 'Invalid BIN');
  const digits = [...value].map(Number);
  const checksum = (shift) => digits.slice(0, 11).reduce(
    (sum, digit, i) => sum + digit * ((i + shift) % 11 + 1), 0
  ) % 11;
  const first = checksum(0);
  if ((first === 10 ? checksum(2) : first) !== digits[11]) throw new HttpError(400, 'Invalid BIN checksum');
  return value;
}

export function first(result) {
  if (!result.rows.length) throw new HttpError(404, 'Resource not found');
  return result.rows[0];
}
