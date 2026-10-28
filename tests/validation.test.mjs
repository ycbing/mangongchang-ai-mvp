import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCanvasSettings, validateCharacterInput } from '../validation.mjs';

test('canvas settings accept supported values and reject malformed values', () => {
  assert.deepEqual(validateCanvasSettings(), { ratio: '4/5', gutter: 16, bg: '#f6f4ed' });
  assert.deepEqual(validateCanvasSettings({ ratio: '1/1', gutter: 32, bg: '#ABCDEF' }), { ratio: '1/1', gutter: 32, bg: '#abcdef' });
  for (const value of [null, [], { ratio: '16/9', gutter: 16, bg: '#ffffff' }, { ratio: '4/5', gutter: 7, bg: '#ffffff' }, { ratio: '4/5', gutter: '16', bg: '#ffffff' }, { ratio: '4/5', gutter: 16, bg: 'red' }]) {
    assert.throws(() => validateCanvasSettings(value), { code: 'VALIDATION_ERROR', status: 422 });
  }
});

test('character input is normalized through a field whitelist', () => {
  const fields = validateCharacterInput({ id: 'attacker-id', createdAt: 1, deletedAt: 1, name: ' 小废柴 ', tags: ['主角', '主角', ''], style: '暖色平涂' });
  assert.deepEqual(fields, { name: '小废柴', tags: ['主角'], style: '暖色平涂' });
  assert.deepEqual(validateCharacterInput({ summary: '认真' }, { partial: true }), { summary: '认真' });
  for (const value of [{ name: ' ' }, { name: '角色', tags: [{}] }, { name: '角色', referenceAssetIds: ['not-a-uuid'] }, { name: '角色', archivedAt: 'now' }]) {
    assert.throws(() => validateCharacterInput(value), { code: 'VALIDATION_ERROR', status: 422 });
  }
});
