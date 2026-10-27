import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { root } from './env.mjs';
import { openDatabase, applyPostgresMigrations } from '../db-adapter.mjs';
if (!process.env.DATABASE_URL) throw new Error('请先在 .env 中设置 DATABASE_URL');
const sourcePath = resolve(process.env.SOURCE_DATABASE_PATH || join(root, 'data', 'mangongchang.sqlite'));
const sourceAssets = resolve(process.env.SOURCE_ASSET_DIR || join(dirname(sourcePath), 'assets'));
const targetAssets = resolve(process.env.LOCAL_STORAGE_DIR || join(root, 'data', 'assets'));
if (!existsSync(sourcePath)) throw new Error(`找不到 SQLite 数据库：${sourcePath}`);
const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const pg = await openDatabase({ databaseUrl: process.env.DATABASE_URL, databasePath: '' });
const tables = {
  users: ['id','email','password_hash','created_at'],
  app_state: ['id','revision','snapshot','updated_at'],
  characters: ['id','owner_id','name','summary','visual_profile_json','style_anchors_json','reference_asset_ids_json','tags_json','created_at','updated_at','archived_at','deleted_at'],
  works: ['id','owner_id','title','premise','status','settings_json','character_snapshot_json','created_at','updated_at','archived_at','deleted_at'],
  work_characters: ['work_id','character_id','snapshot_json'],
  panels: ['id','work_id','order_index','storyboard_json','layout_json','current_image_asset_id','generation_status','updated_at'],
  state_history: ['revision','snapshot','created_at'],
  jobs: ['id','owner_id','type','status','progress','input_json','result_json','error_json','idempotency_key','previous_job_id','attempts','created_at','started_at','finished_at'],
  sessions: ['token_hash','owner_id','expires_at','created_at'],
  assets: ['id','owner_id','work_id','panel_id','kind','storage_key','mime_type','width','height','size_bytes','checksum','metadata_json','created_at'],
  exports: ['id','owner_id','work_id','job_id','format','width','height','slice_count','asset_ids_json','status','options_json','created_at'],
};
try {
  await applyPostgresMigrations(pg, join(root, 'migrations'));
  const occupied = await pg.prepare('SELECT (SELECT count(*) FROM app_state) AS state_count, (SELECT count(*) FROM assets) AS asset_count, (SELECT count(*) FROM jobs) AS job_count').get();
  if (Number(occupied.state_count) || Number(occupied.asset_count) || Number(occupied.job_count)) throw new Error('目标 PostgreSQL 已有作品、资源或任务数据。为避免覆盖，请使用一个空数据库导入。');
  const state = sqlite.prepare('SELECT count(*) AS count FROM app_state').get();
  if (!state.count) throw new Error('SQLite 数据库中没有 app_state 数据。');
  if (existsSync(sourceAssets)) {
    await mkdir(targetAssets, { recursive: true });
    for (const entry of await readdir(sourceAssets, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const from = join(sourceAssets, entry.name), to = join(targetAssets, entry.name);
      if (existsSync(to)) { const a = await stat(from), b = await stat(to); if (a.size !== b.size) throw new Error(`目标图片已存在且大小不同：${entry.name}`); }
      else await copyFile(from, to);
    }
  }
  await pg.transaction(async tx => {
    for (const [table, columns] of Object.entries(tables)) {
      const rows = sqlite.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all();
      for (const row of rows) await tx.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column] ?? null));
      console.log(`${table}: ${rows.length} 行`);
    }
  });
  console.log(`SQLite 数据已导入 PostgreSQL；图片已复制到 ${targetAssets}`);
} finally { sqlite.close(); await pg.close(); }
