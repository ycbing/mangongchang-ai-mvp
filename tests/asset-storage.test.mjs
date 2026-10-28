import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openAssetStorage } from '../asset-storage.mjs';

test('S3 asset reads verify stored SHA-256 metadata before returning bytes', async () => {
  const names = ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const payload = Buffer.from('comic-panel-image');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const requests = [];
  class Command { constructor(input) { this.input = input; } }
  class S3Client {
    constructor(config) { this.config = config; }
    async send(command) {
      requests.push(command);
      if (command instanceof GetObjectCommand) {
        const metadata = this.config.metadata || { sha256 };
        return { ContentLength: payload.length, Metadata: metadata, Body: (async function* () { yield payload; })() };
      }
      return {};
    }
    destroy() {}
  }
  class HeadBucketCommand extends Command {}
  class HeadObjectCommand extends Command {}
  class PutObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  const sdk = { S3Client, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
  Object.assign(process.env, { S3_BUCKET: 'mangongchang-test', S3_ENDPOINT: 'https://objects.example.test', S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret', S3_FORCE_PATH_STYLE: 'true' });
  try {
    const storage = await openAssetStorage({ directory: '/tmp/mangongchang-unused', s3Sdk: sdk });
    assert.deepEqual(await storage.get('panel.png', 100), payload);
    await assert.rejects(storage.get('../panel.png'), /资源存储键无效/);
    const putPayload = Buffer.from('another-image');
    await storage.put('another.png', putPayload, 'image/png');
    const putRequest = requests.find(request => request instanceof PutObjectCommand);
    assert.equal(putRequest.input.Metadata.sha256, createHash('sha256').update(putPayload).digest('hex'));
    await storage.close();

    class MismatchedS3Client extends S3Client {
      constructor(config) { super({ ...config, metadata: { sha256: '0'.repeat(64) } }); }
    }
    const mismatchedStorage = await openAssetStorage({ directory: '/tmp/mangongchang-unused', s3Sdk: { ...sdk, S3Client: MismatchedS3Client } });
    await assert.rejects(mismatchedStorage.get('panel.png'), { code: 'OBJECT_CHECKSUM_MISMATCH' });
    await mismatchedStorage.close();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
