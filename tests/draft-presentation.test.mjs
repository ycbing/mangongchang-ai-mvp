import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingDraftPresentation, pendingDraftUnavailableMessage } from '../draft-presentation.js';

test('pending draft presentation clearly distinguishes browser storage from memory-only drafts', () => {
  const cached = pendingDraftPresentation({ storageAvailable: true, hasRemote: true });
  assert.match(cached.storageNotice, /已存入此浏览器/);
  assert.equal(cached.keepLabel, '继续保留草稿');

  const memoryOnly = pendingDraftPresentation({ storageAvailable: false, hasRemote: false });
  assert.match(memoryOnly.storageNotice, /只在当前页面内存中/);
  assert.match(memoryOnly.storageNotice, /刷新或关闭页面会丢失/);
  assert.match(memoryOnly.recoveryNotice, /服务器版本暂不可用/);
  assert.match(memoryOnly.keepLabel, /离开页面会丢失/);
});

test('offline draft notices do not claim an unavailable browser cache preserved the draft', () => {
  assert.match(pendingDraftUnavailableMessage(true), /已保存在浏览器/);
  assert.match(pendingDraftUnavailableMessage(false), /仅保留在当前页面/);
});
