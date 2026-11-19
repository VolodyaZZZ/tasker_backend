import test from 'node:test';
import assert from 'node:assert/strict';
import { rating } from '../src/validation.js';

test('multipart ratings accept exactly the five integer scores', () => {
  for (let score = 1; score <= 5; score += 1) {
    assert.equal(rating(String(score)), score);
  }
  for (const invalid of [undefined, '0', '6', '3.5', '5.0', '05', ' 5', ['5']]) {
    assert.throws(() => rating(invalid), { status: 400 });
  }
});
