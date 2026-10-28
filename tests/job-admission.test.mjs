import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db-adapter.mjs';
import { insertJobsWithinLimit } from '../job-admission.mjs';
import { createJobQueue } from '../job-queue.mjs';

test('separate web and worker roles require the shared Redis queue', async () => {
  const localQueue = await createJobQueue({ redisUrl: '', role: 'combined' });
  assert.equal(localQueue.kind, 'in-process');
  await assert.rejects(createJobQueue({ redisUrl: '', role: 'web' }), /requires REDIS_URL/);
  await assert.rejects(createJobQueue({ redisUrl: '', role: 'worker' }), /requires REDIS_URL/);
});

test('job admission serializes concurrent batches and rolls back over-capacity writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-jobs-'));
  const db = await openDatabase({ databaseUrl: '', databasePath: join(directory, 'test.sqlite') });
  try {
    await db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,progress INTEGER NOT NULL,input_json TEXT NOT NULL,idempotency_key TEXT,previous_job_id TEXT,attempts INTEGER NOT NULL,created_at BIGINT NOT NULL)');
    const batch = count => Array.from({ length: count }, () => ({ id: randomUUID(), type: 'panel_image', status: 'queued', input: {}, createdAt: Date.now() }));
    const concurrent = await Promise.allSettled([insertJobsWithinLimit(db, 'owner', batch(12)), insertJobsWithinLimit(db, 'owner', batch(12))]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = concurrent.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'QUEUE_LIMIT');
    assert.equal(Number((await db.prepare("SELECT count(*) n FROM jobs WHERE owner_id=? AND status='queued'").get('owner')).n), 12);
    await insertJobsWithinLimit(db, 'owner', batch(8));
    await assert.rejects(insertJobsWithinLimit(db, 'owner', batch(1)), { code: 'QUEUE_LIMIT', status: 429 });
    assert.equal(Number((await db.prepare("SELECT count(*) n FROM jobs WHERE owner_id=? AND status='queued'").get('owner')).n), 20);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
