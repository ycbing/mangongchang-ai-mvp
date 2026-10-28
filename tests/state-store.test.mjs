import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db-adapter.mjs';
import { mutateSnapshot, persistSnapshot } from '../state-store.mjs';

test('snapshot mutations retry revision conflicts and preserve both writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-state-'));
  const db = await openDatabase({ databaseUrl: '', databasePath: join(directory, 'test.sqlite') });
  try {
    await db.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,updated_at INTEGER NOT NULL)');
    await db.exec('CREATE TABLE state_history(revision INTEGER PRIMARY KEY,snapshot TEXT NOT NULL,created_at INTEGER NOT NULL)');
    const initial = { works: [], characters: [] }, now = Date.now();
    await db.prepare('INSERT INTO app_state(id,revision,snapshot,updated_at) VALUES(1,1,?,?)').run(JSON.stringify(initial), now);
    await db.prepare('INSERT INTO state_history(revision,snapshot,created_at) VALUES(1,?,?)').run(JSON.stringify(initial), now);
    const syncProjection = async () => {};
    const writers = ['web', 'worker'].map(name => mutateSnapshot(db, snapshot => { snapshot.works.push({ id: name }); return name; }, syncProjection));
    const results = await Promise.all(writers);
    assert.deepEqual(results.map(result => result.revision).sort(), [2, 3]);
    const current = await db.prepare('SELECT revision,snapshot FROM app_state WHERE id=1').get();
    assert.deepEqual(JSON.parse(current.snapshot).works.map(work => work.id).sort(), ['web', 'worker']);
    assert.equal(Number(current.revision), 3);
    assert.equal(Number((await db.prepare('SELECT count(*) n FROM state_history').get()).n), 3);
    const conflict = await persistSnapshot(db, { works: [], characters: [] }, 1, syncProjection);
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.revision, 3);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
