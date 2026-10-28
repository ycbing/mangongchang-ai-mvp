import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db-adapter.mjs';
import { heartbeatRunningJob, recoverExpiredJobs } from '../job-lease.mjs';

test('worker heartbeats keep live jobs leased while stale jobs recover atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-job-lease-'));
  const db = await openDatabase({ databaseUrl: '', databasePath: join(directory, 'test.sqlite') });
  const now = Date.now();
  try {
    await db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,owner_id TEXT,type TEXT,status TEXT,progress INTEGER,input_json TEXT,result_json TEXT,error_json TEXT,idempotency_key TEXT,previous_job_id TEXT,attempts INTEGER,created_at INTEGER,started_at INTEGER,heartbeat_at INTEGER,finished_at INTEGER)`);
    const insert = db.prepare('INSERT INTO jobs(id,owner_id,type,status,progress,input_json,attempts,created_at,started_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    await insert.run('live', 'owner', 'storyboard', 'running', 25, '{}', 1, now - 600_000, now - 600_000, now - 20_000);
    await insert.run('legacy-stale', 'owner', 'storyboard', 'running', 25, '{}', 1, now - 600_000, now - 600_000, null);
    await insert.run('cancel-live', 'owner', 'panel_image', 'cancel_requested', 25, '{}', 1, now - 600_000, now - 600_000, now - 20_000);
    await insert.run('cancel-stale', 'owner', 'panel_image', 'cancel_requested', 25, '{}', 1, now - 600_000, now - 600_000, now - 600_000);
    await insert.run('other-owner', 'another', 'storyboard', 'running', 25, '{}', 1, now - 600_000, now - 600_000, null);

    await heartbeatRunningJob(db, 'owner', 'live', now);
    const recovered = await recoverExpiredJobs(db, 'owner', now - 300_000);
    assert.deepEqual(recovered, { requeued: 1, cancelled: 1 });
    const rows = (await db.prepare('SELECT id,status,progress,started_at,heartbeat_at,finished_at FROM jobs ORDER BY id').all()).map(row => ({ ...row }));
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    assert.equal(byId.live.status, 'running');
    assert.equal(Number(byId.live.heartbeat_at), now);
    assert.equal(byId['legacy-stale'].status, 'queued');
    assert.equal(byId['legacy-stale'].heartbeat_at, null);
    assert.equal(Number(byId['legacy-stale'].progress), 0);
    assert.equal(byId['cancel-live'].status, 'cancel_requested');
    assert.equal(byId['cancel-stale'].status, 'cancelled');
    assert.ok(byId['cancel-stale'].finished_at);
    assert.equal(byId['other-owner'].status, 'running');
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
