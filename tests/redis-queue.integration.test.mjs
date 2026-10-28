import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJobQueue } from '../job-queue.mjs';

const redisUrl = process.env.REDIS_TEST_URL || '';

test('BullMQ delivers a durable job from the web role to the separate worker role', {
  skip: !redisUrl && 'Set REDIS_TEST_URL to a disposable Redis database to run the queue integration test.',
}, async () => {
  const jobId = `ci-${randomUUID()}`;
  let processed;
  let timeout;
  const delivered = new Promise(resolve => { processed = resolve; });
  const worker = await createJobQueue({ redisUrl, role: 'worker', concurrency: 1, processJob: async id => { processed(id); } });
  let web;
  try {
    web = await createJobQueue({ redisUrl, role: 'web', concurrency: 1, processJob: async () => {} });
    assert.equal(worker.kind, 'bullmq');
    assert.equal(web.kind, 'bullmq');
    assert.equal(await worker.health(), true);
    assert.equal(await web.health(), true);
    await web.enqueue({ id: jobId, type: 'ci-queue-smoke' });
    const receivedId = await Promise.race([
      delivered,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Redis worker did not receive the enqueued job')), 10_000); }),
    ]);
    assert.equal(receivedId, jobId);
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled([web?.close(), worker.close()]);
  }
});
