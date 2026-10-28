import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedInteger, validateProductionAuth, validateProductionDatabase } from '../runtime-config.mjs';

test('runtime integer settings use defaults and accept valid boundaries', () => {
  assert.equal(boundedInteger('LIMIT', 12, 1, 20, {}), 12);
  assert.equal(boundedInteger('LIMIT', 12, 1, 20, { LIMIT: '' }), 12);
  assert.equal(boundedInteger('LIMIT', 12, 1, 20, { LIMIT: '1' }), 1);
  assert.equal(boundedInteger('LIMIT', 12, 1, 20, { LIMIT: '20' }), 20);
});

test('production mode requires a sufficiently long access password while development stays optional', () => {
  assert.doesNotThrow(() => validateProductionAuth({ NODE_ENV: 'development', AUTH_PASSWORD: '' }));
  assert.throws(() => validateProductionAuth({ NODE_ENV: 'production', AUTH_PASSWORD: '' }), /AUTH_PASSWORD is required in production/);
  assert.throws(() => validateProductionAuth({ NODE_ENV: 'production', AUTH_PASSWORD: 'short-password' }), /at least 16 characters/);
  assert.doesNotThrow(() => validateProductionAuth({ NODE_ENV: 'production', AUTH_PASSWORD: 'a-long-random-password' }));
});

test('production mode requires PostgreSQL while local modes retain SQLite', () => {
  assert.doesNotThrow(() => validateProductionDatabase({ NODE_ENV: 'development', DATABASE_URL: '' }));
  assert.doesNotThrow(() => validateProductionDatabase({ NODE_ENV: 'test', DATABASE_URL: 'file:test.sqlite' }));
  assert.throws(() => validateProductionDatabase({ NODE_ENV: 'production', DATABASE_URL: '' }), /DATABASE_URL is required in production/);
  assert.throws(() => validateProductionDatabase({ NODE_ENV: 'production', DATABASE_URL: 'file:local.sqlite' }), /must use PostgreSQL/);
  assert.throws(() => validateProductionDatabase({ NODE_ENV: 'production', DATABASE_URL: 'not-a-postgres-url' }), /valid PostgreSQL/);
  assert.doesNotThrow(() => validateProductionDatabase({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:pass@db:5432/app' }));
});

test('runtime integer settings fail closed on malformed and unsafe values', () => {
  for (const value of ['NaN', 'Infinity', '1.5', '0', '-1', '21', '9007199254740992', ' 2']) {
    assert.throws(() => boundedInteger('LIMIT', 12, 1, 20, { LIMIT: value }), /LIMIT must be an integer between 1 and 20/);
  }
});
