// Unit tests for the DB adapter's Postgres param conversion. This gives the
// pg backend direct coverage without needing a live Postgres instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPg } from '../lib/db.js';

test('converts :name placeholders to positional $n', () => {
  const { text, values } = toPg('SELECT * FROM t WHERE a = :a AND b = :b', { a: 1, b: 'x' });
  assert.equal(text, 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.deepEqual(values, [1, 'x']);
});

test('reuses the same $n for a repeated param name', () => {
  const { text, values } = toPg('INSERT INTO t (created, updated) VALUES (:ts, :ts)', { ts: 42 });
  assert.equal(text, 'INSERT INTO t (created, updated) VALUES ($1, $1)');
  assert.deepEqual(values, [42]);
});

test('missing params become null (not undefined)', () => {
  const { values } = toPg('SELECT :a, :b', { a: 1 });
  assert.deepEqual(values, [1, null]);
});

test('preserves order across mixed repeated/new names', () => {
  const { text, values } = toPg('SELECT :a, :b, :a, :c', { a: 'x', b: 'y', c: 'z' });
  assert.equal(text, 'SELECT $1, $2, $1, $3');
  assert.deepEqual(values, ['x', 'y', 'z']);
});
