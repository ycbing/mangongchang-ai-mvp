import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import '../comic-art.js';
import { normalizeExportOptions, renderComicExports } from '../export-renderer.mjs';

function work(panelCount, ratio = '4/5') {
  return { id: 'work-export', settings: { ratio, bg: '#f6f4ed' }, panels: Array.from({ length: panelCount }, (_, index) => ({ id: `panel-${index + 1}`, version: 1, tone: index % 2 ? 'message' : 'hope', dialogue: index === 0 ? '一段用于验证文字排版的对白' : '', caption: index === 7 ? '小废柴：这次真的。' : '' })) };
}

test('server export renders 8 panels into bounded PNG slices with stable order and progress', async () => {
  const progress = [];
  const result = await renderComicExports({ work: work(8), options: { width: 1080, maxHeight: 8000, gutter: 16, background: '#f6f4ed' }, loadImage: async () => null, onProgress: async (done, total) => progress.push([done, total]) });
  assert.equal(result.slices.length, 2);
  assert.deepEqual(result.slices.map(slice => [slice.panelStart, slice.panelEnd]), [[1, 6], [7, 8]]);
  assert.ok(result.slices.every(slice => slice.height <= 8000));
  assert.equal(result.height, result.slices.reduce((sum, slice) => sum + slice.height, 0));
  assert.deepEqual(progress.at(-1), [8, 8]);
  for (const slice of result.slices) {
    const metadata = await sharp(slice.buffer).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, slice.height);
  }
});

test('server export handles generated panel assets and rejects unsupported output options', async () => {
  const image = await sharp({ create: { width: 240, height: 120, channels: 3, background: '#315f8c' } }).png().toBuffer();
  let loaded = 0;
  const result = await renderComicExports({ work: work(1, '1/1'), options: { width: 750, maxHeight: 8000, gutter: 16, ratio: [1, 1], background: '#ffffff' }, loadImage: async () => { loaded++; return image; } });
  assert.equal(loaded, 1);
  assert.equal(result.slices[0].width, 750);
  assert.equal((await sharp(result.slices[0].buffer).metadata()).height, 750);
  assert.throws(() => normalizeExportOptions({ width: 700, maxHeight: 8000, gutter: 16, ratio: '4/5' }), { code: 'INVALID_EXPORT_OPTIONS' });
});
