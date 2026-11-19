import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';

test('catalog, review rating and complaint moderation', {
  skip: !process.env.TASKER_TEST_DATABASE_URL
}, async (t) => {
  process.env.DATABASE_URL = process.env.TASKER_TEST_DATABASE_URL;
  process.env.JWT_SECRET = 'local-integration-secret-at-least-32-bytes';
  const uploads = await mkdtemp(join(tmpdir(), 'tasker-uploads-'));
  process.env.UPLOADS_DIR = uploads;
  const { app } = await import('../src/app.js');
  const { pool } = await import('../src/db.js');
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    for (const file of await readdir(uploads)) await unlink(join(uploads, file));
    await rmdir(uploads);
  });
  await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, status, token, body) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(address + '/api' + path, { method, headers, body });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }

  const password = 'integration-password';
  const email = 'admin@example.test';
  await pool.query("INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Admin', $2, 'admin')", [
    email, await bcrypt.hash(password, 4)
  ]);
  const admin = await api('POST', '/auth/login', 200, null, { role: 'admin', email, password });
  const company = await api('POST', '/auth/register/company', 201, null, {
    name: 'Sample Company', email: 'company@example.test', password, bin: '123456789013'
  });
  const people = [];
  for (let i = 0; i < 3; i += 1) {
    people.push(await api('POST', '/auth/register/user', 201, null, {
      email: `person${i}@example.test`, full_name: `Person ${i}`, password
    }));
  }

  const companyId = company.account.id;
  assert.equal((await api('GET', '/company/dashboard', 200, company.token)).rating, null);
  const promotion = await api('POST', '/company/promotions', 201, company.token, {
    title: 'Sample Challenge', description: 'Do the challenge', source_url: 'https://example.test/challenge'
  });
  const promotionId = promotion.id;
  await api('POST', `/company/promotions/${promotionId}/submit`, 403, company.token);
  await api('PATCH', `/admin/companies/${companyId}/status`, 200, admin.token, { status: 'approved' });
  await api('POST', `/company/promotions/${promotionId}/submit`, 200, company.token);
  await api('GET', `/promotions/${promotionId}`, 404);
  await api('PATCH', `/admin/promotions/${promotionId}/status`, 200, admin.token, { status: 'approved' });
  assert.ok((await api('GET', '/promotions', 200)).some((item) => item.id === promotionId));

  const photo = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000000' } }).png().toBuffer();
  function review(score) {
    const form = new FormData();
    form.set('rating', score);
    form.set('comment', 'Completed the challenge');
    form.set('photo', new Blob([photo], { type: 'image/png' }), 'review.png');
    return form;
  }
  const reviewPath = `/user/promotions/${promotionId}/reviews`;
  await api('POST', reviewPath, 400, people[0].token, review('6'));
  const firstReview = await api('POST', reviewPath, 201, people[0].token, review('5'));
  const image = await fetch(address + firstReview.photo_path);
  assert.equal(image.status, 200);
  await image.arrayBuffer();
  await api('POST', reviewPath, 409, people[0].token, review('1'));
  const secondReview = await api('POST', reviewPath, 201, people[1].token, review('2'));
  assert.equal((await api('GET', `/companies/${companyId}`, 200)).rating, 3.5);
  await assert.rejects(pool.query('UPDATE reviews SET rating = 0 WHERE id = $1', [secondReview.id]), { code: '23514' });
  await pool.query('UPDATE reviews SET rating = 1 WHERE id = $1', [secondReview.id]);
  assert.equal((await api('GET', `/companies/${companyId}`, 200)).rating, 3);
  await pool.query('DELETE FROM reviews WHERE id = $1', [secondReview.id]);
  assert.equal((await api('GET', `/companies/${companyId}`, 200)).rating, 5);

  const reports = await Promise.all(people.map(({ token }) => api(
    'POST', `/user/promotions/${promotionId}/reports`, 201, token, {
      reason_type: 'other', description: 'A sample report for the challenge'
    }
  )));
  assert.ok((await api('GET', '/admin/reports', 200, admin.token)).some(({ id }) => id === reports[0].id));
  await Promise.all(reports.map(({ id }) => api(
    'PATCH', `/admin/reports/${id}/resolve`, 200, admin.token, {
      status: 'approved', admin_comment: 'Confirmed on review'
    }
  )));
  await api('GET', '/company/dashboard', 403, company.token);
  await api('GET', `/promotions/${promotionId}`, 404);
  const dashboard = await api('GET', '/user/dashboard', 200, people[0].token);
  assert.equal(dashboard.review_count, 1);
  assert.equal(dashboard.reports[0].admin_comment, 'Confirmed on review');
});
