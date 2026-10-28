import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db-adapter.mjs';
import { syncDatabaseProjection } from '../projection-store.mjs';

const schema = `
  CREATE TABLE characters(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,summary TEXT NOT NULL,visual_profile_json TEXT NOT NULL,style_anchors_json TEXT NOT NULL,reference_asset_ids_json TEXT NOT NULL,tags_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,archived_at INTEGER,deleted_at INTEGER);
  CREATE TABLE works(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,title TEXT NOT NULL,premise TEXT NOT NULL,status TEXT NOT NULL,settings_json TEXT NOT NULL,character_snapshot_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,archived_at INTEGER,deleted_at INTEGER);
  CREATE TABLE work_characters(work_id TEXT NOT NULL,character_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(work_id,character_id));
  CREATE TABLE panels(id TEXT NOT NULL,work_id TEXT NOT NULL,order_index INTEGER NOT NULL,storyboard_json TEXT NOT NULL,layout_json TEXT NOT NULL,current_image_asset_id TEXT,generation_status TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(work_id,id),UNIQUE(work_id,order_index));
`;
const panel = (id, scene = id) => ({ id, scene, versions: [1], version: 1, imageVersions: [], elements: [] });
const character = (id, name, updatedAt = 1) => ({ id, name, summary: '', look: `${name} look`, style: 'warm comic', tags: [], referenceAssetIds: [], createdAt: 1, updatedAt });
const work = (id, characterId, panels, title = id) => ({ id, title, premise: 'premise', characterId, characterSnapshot: { name: 'snapshot' }, status: 'editing', settings: { ratio: '4/5' }, panels, createdAt: 1, updatedAt: 2 });

test('projection synchronization updates only changed records, safely reorders panels, and removes stale rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-projection-'));
  const db = await openDatabase({ databaseUrl: '', databasePath: join(directory, 'test.sqlite') });
  try {
    await db.exec(schema);
    await db.prepare('INSERT INTO characters(id,owner_id,name,summary,visual_profile_json,style_anchors_json,reference_asset_ids_json,tags_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('other-character', 'other-owner', 'Other', '', '{}', '{}', '[]', '[]', 1, 1);
    await db.prepare('INSERT INTO works(id,owner_id,title,premise,status,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('other-work', 'other-owner', 'Other work', '', 'editing', '{}', 1, 1);
    await db.prepare('INSERT INTO panels(id,work_id,order_index,storyboard_json,layout_json,updated_at) VALUES(?,?,?,?,?,?)')
      .run('other-panel', 'other-work', 0, '{}', '{}', 1);

    const first = {
      characters: [character('char-1', 'First'), character('char-2', 'Second')],
      works: [work('work-1', 'char-1', [panel('p1'), panel('p2'), panel('p3')]), work('work-removed', 'char-2', [panel('old')])],
    };
    await db.transaction(tx => syncDatabaseProjection(tx, first, 'local-owner'));

    const updated = {
      characters: [character('char-1', 'Renamed', 3)],
      works: [work('work-1', 'char-1', [panel('p3', 'new third'), panel('p1', 'new first'), panel('p4', 'added')], 'Updated title')],
    };
    await db.transaction(tx => syncDatabaseProjection(tx, updated, 'local-owner'));

    const chars = (await db.prepare('SELECT id,name FROM characters WHERE owner_id=? ORDER BY id').all('local-owner')).map(row => ({ ...row }));
    assert.deepEqual(chars, [{ id: 'char-1', name: 'Renamed' }]);
    const works = (await db.prepare('SELECT id,title FROM works WHERE owner_id=?').all('local-owner')).map(row => ({ ...row }));
    assert.deepEqual(works, [{ id: 'work-1', title: 'Updated title' }]);
    const links = await db.prepare('SELECT work_id,character_id FROM work_characters WHERE work_id=?').get('work-1');
    assert.deepEqual({ ...links }, { work_id: 'work-1', character_id: 'char-1' });
    const panels = await db.prepare('SELECT id,order_index,storyboard_json FROM panels WHERE work_id=? ORDER BY order_index').all('work-1');
    assert.deepEqual(panels.map(item => [item.id, Number(item.order_index), JSON.parse(item.storyboard_json).scene]), [['p3', 0, 'new third'], ['p1', 1, 'new first'], ['p4', 2, 'added']]);
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM works WHERE id=? AND owner_id=?').get('other-work', 'other-owner')).n), 1);
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM panels WHERE id=? AND work_id=?').get('other-panel', 'other-work')).n), 1);
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM characters WHERE id=? AND owner_id=?').get('other-character', 'other-owner')).n), 1);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
