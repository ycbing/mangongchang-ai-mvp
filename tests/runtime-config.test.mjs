import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedInteger } from '../runtime-config.mjs';

test('runtime integer settings use defaults and accept valid boundaries', () => {
  assert.equal(boundedInteger('LIMIT', 12, 1, 20, {}), 12);
  assert.equal(boundedInteger('LIMIT', 12, 1, 20, { LIMIT: '' }), 12);
  assert.equal(boundedInteger('LIMIT', 12, 1, 20, { LIMIT: '1' }), 1);
  assert.equal(boundedInteger('LIMIT', 12, 1, 20, { LIMIT: '20' }), 20);
});

test('runtime integer settings fail closed on malformed and unsafe values', () => {
  for (const value of ['NaN', 'Infinity', '1.5', '0', '-1', '21', '9007199254740992', ' 2']) {
    assert.throws(() => boundedInteger('LIMIT', 12, 1, 20, { LIMIT: value }), /LIMIT must be an integer between 1 and 20/);
  }
});
