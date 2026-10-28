import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db-adapter.mjs';
import { createCompletedExport, listWorkExports } from '../export-store.mjs';

test('completed exports atomically record jobs, owned slices, and idempotent history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-export-'));
  const db = await openDatabase({ databaseUrl: '', databasePath: join(directory, 'test.sqlite') });
  try {
    await db.exec(`
      CREATE TABLE jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,progress INTEGER NOT NULL,input_json TEXT NOT NULL,result_json TEXT,error_json TEXT,idempotency_key TEXT,previous_job_id TEXT,attempts INTEGER NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER);
      CREATE UNIQUE INDEX jobs_owner_idempotency ON jobs(owner_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE assets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,work_id TEXT,kind TEXT NOT NULL,size_bytes INTEGER NOT NULL);
      CREATE TABLE exports(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,work_id TEXT NOT NULL,job_id TEXT NOT NULL,format TEXT NOT NULL,width INTEGER,height INTEGER,slice_count INTEGER NOT NULL,asset_ids_json TEXT NOT NULL,status TEXT NOT NULL,options_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    `);
    await db.prepare('INSERT INTO assets(id,owner_id,work_id,kind,size_bytes) VALUES(?,?,?,?,?)').run('slice-1', 'owner', 'work-1', 'export_slice', 128);
    await db.prepare('INSERT INTO assets(id,owner_id,work_id,kind,size_bytes) VALUES(?,?,?,?,?)').run('slice-foreign', 'owner', 'work-2', 'export_slice', 128);

    const record = await createCompletedExport(db, { ownerId: 'owner', workId: 'work-1', assetIds: ['slice-1'], width: 900, height: 4200, options: { gutter: 16 }, idempotencyKey: 'export-once' });
    const replay = await createCompletedExport(db, { ownerId: 'owner', workId: 'work-1', assetIds: ['slice-1'], width: 900, height: 4200, options: { gutter: 16 }, idempotencyKey: 'export-once' });
    assert.equal(record.id, replay.id);
    assert.equal(record.jobId, replay.jobId);
    assert.equal(record.status, 'succeeded');
    assert.deepEqual(record.assetIds, ['slice-1']);
    assert.deepEqual((await listWorkExports(db, 'owner', 'work-1')).map(item => item.id), [record.id]);
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM jobs').get()).n), 1);
    await assert.rejects(createCompletedExport(db, { ownerId: 'owner', workId: 'work-1', assetIds: ['slice-foreign'], width: 900, height: 4200 }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(createCompletedExport(db, { ownerId: 'owner', workId: 'work-1', assetIds: ['slice-1', 'slice-1'], width: 900, height: 4200 }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(createCompletedExport(db, { ownerId: 'owner', workId: 'work-2', assetIds: ['slice-foreign'], width: 900, height: 4200, idempotencyKey: 'export-once' }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM jobs').get()).n), 1, 'invalid exports must roll back without a job record');
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
