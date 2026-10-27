import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
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
  const occupancySql = Object.keys(tables).map(table => `(SELECT count(*) FROM ${table}) AS ${table}_count`).join(', ');
  const occupied = await pg.prepare(`SELECT ${occupancySql}`).get();
  if (Object.values(occupied).some(value => Number(value) > 0)) throw new Error('目标 PostgreSQL 已有数据。为避免覆盖，请使用一个全新空数据库。');
  const state = sqlite.prepare('SELECT count(*) AS count FROM app_state').get();
  if (!state.count) throw new Error('SQLite 数据库中没有 app_state 数据。');

  // Preflight every referenced file before inserting any metadata into PostgreSQL.
  const sourceAssetRows = sqlite.prepare('SELECT storage_key,checksum FROM assets').all();
  if (sourceAssetRows.length && !existsSync(sourceAssets)) throw new Error(`SQLite 资源目录不存在：${sourceAssets}`);
  const filesToCopy = [];
  for (const asset of sourceAssetRows) {
    const key = String(asset.storage_key || '');
    if (!key || key !== key.split(/[\\/]/).at(-1) || key.startsWith('.')) throw new Error(`资源记录包含无效存储路径：${key}`);
    const from = join(sourceAssets, key);
    const sourceInfo = await lstat(from);
    if (!sourceInfo.isFile()) throw new Error(`资源不是普通文件：${key}`);
    const sourceBytes = await readFile(from);
    const checksum = createHash('sha256').update(sourceBytes).digest('hex');
    if (checksum !== asset.checksum) throw new Error(`源图片校验失败：${key}`);
    const to = join(targetAssets, key);
    if (existsSync(to)) {
      const targetBytes = await readFile(to);
      if (createHash('sha256').update(targetBytes).digest('hex') !== checksum) throw new Error(`目标图片已存在且校验和不同：${key}`);
    } else filesToCopy.push({ from, to });
  }
  if (filesToCopy.length) await mkdir(targetAssets, { recursive: true });
  for (const file of filesToCopy) await copyFile(file.from, file.to);

  await pg.transaction(async tx => {
    for (const [table, columns] of Object.entries(tables)) {
      const rows = sqlite.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all();
      for (const row of rows) await tx.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column] ?? null));
      console.log(`${table}: ${rows.length} 行`);
    }
  });
  console.log(`SQLite 数据已导入 PostgreSQL；图片已复制到 ${targetAssets}`);
} finally {
  sqlite.close();
  await pg.close();
}
