import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { verifyImage } from '../image-validation.mjs';

test('image validation records real JPEG and WebP dimensions and checks the declared format', async () => {
  for (const [format, mime] of [['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const bytes = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#426c91' } }).toFormat(format).toBuffer();
    assert.deepEqual(await verifyImage(bytes, mime), { width: 320, height: 180 });
    await assert.rejects(verifyImage(bytes, 'image/png'), { code: 'INVALID_IMAGE' });
  }
});

test('image validation rejects oversized decoded images and invalid payloads', async () => {
  const oversized = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(verifyImage(oversized, 'image/png'), { code: 'INVALID_IMAGE' });
  await assert.rejects(verifyImage(Buffer.from('not-an-image'), 'image/jpeg'), { code: 'INVALID_IMAGE' });
});
