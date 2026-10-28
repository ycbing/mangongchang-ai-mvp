import { join, resolve } from 'node:path';
import { root } from './env.mjs';
import { openDatabase, applyPostgresMigrations } from '../db-adapter.mjs';
import { openAssetStorage } from '../asset-storage.mjs';

const ownerId = 'local-owner';
const apply = process.argv.includes('--apply');
const graceArg = process.argv.find(value => value.startsWith('--grace-days='));
const graceDays = graceArg ? Number(graceArg.slice('--grace-days='.length)) : 30;
const allowedArgs = new Set(['--apply', ...(graceArg ? [graceArg] : [])]);
const unknown = process.argv.slice(2).filter(value => !allowedArgs.has(value));
if (unknown.length) throw new Error(`不支持的参数：${unknown.join(' ')}`);
if (!Number.isInteger(graceDays) || graceDays < 7 || graceDays > 365) throw new Error('--grace-days 必须是 7–365 之间的整数');

function collectReferences(value) {
  const ids = new Set(), keys = new Set(), pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) { pending.push(...current); continue; }
    for (const [key, entry] of Object.entries(current)) {
      if (key === 'assetId' && typeof entry === 'string') ids.add(entry);
      if ((key === 'assetIds' || key === 'referenceAssetIds') && Array.isArray(entry)) {
        for (const id of entry) if (typeof id === 'string') ids.add(id);
      }
      if ((key === 'url' || key === 'referenceUrl') && typeof entry === 'string') {
        const match = entry.match(/(?:^|\/)assets\/([a-zA-Z0-9-]+\.(?:png|jpg|webp))(?:[?#]|$)/i);
        if (match) keys.add(match[1]);
      }
      if (entry && typeof entry === 'object') pending.push(entry);
    }
  }
  return { ids, keys };
}

const databasePath = resolve(process.env.DATABASE_PATH || join(root, 'data', 'mangongchang.sqlite'));
const assetDirectory = resolve(process.env.LOCAL_STORAGE_DIR || join(root, 'data', 'assets'));
let db, storage;
try {
  db = await openDatabase({ databaseUrl: process.env.DATABASE_URL || '', databasePath });
  if (db.kind === 'postgres') await applyPostgresMigrations(db, join(root, 'migrations'));
  storage = await openAssetStorage({ directory: assetDirectory });
  const snapshotRow = await db.prepare('SELECT snapshot FROM app_state WHERE id=1').get();
  if (!snapshotRow) throw new Error('找不到作品状态快照；已停止清理。');
  const references = collectReferences(JSON.parse(snapshotRow.snapshot));
  const cutoff = Date.now() - graceDays * 86400_000;
  const candidates = (await db.prepare('SELECT id,storage_key,size_bytes,created_at FROM assets WHERE owner_id=? AND created_at<? ORDER BY created_at').all(ownerId, cutoff))
    .filter(row => !references.ids.has(row.id) && !references.keys.has(row.storage_key));
  const totalBytes = candidates.reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
  console.log(`${apply ? '清理模式' : '预览模式'}：${graceDays} 天前的未引用资源 ${candidates.length} 个，共 ${(totalBytes / 1_000_000).toFixed(2)} MB。`);
  if (candidates.length) {
    console.log('资源清单（存储键 | 资源 ID | 大小 | 已保存天数）：');
    for (const asset of candidates) {
      const ageDays = Math.max(0, Math.floor((Date.now() - Number(asset.created_at)) / 86400_000));
      console.log(`${asset.storage_key} | ${asset.id} | ${Number(asset.size_bytes || 0)} B | ${ageDays} 天`);
    }
  }
  if (!apply) {
    console.log('未删除任何文件。检查上方清单并备份后，使用 npm run assets:gc -- --apply 执行清理。');
  } else {
    let deleted = 0;
    for (const asset of candidates) {
      await storage.delete(asset.storage_key);
      await db.prepare('DELETE FROM assets WHERE id=? AND owner_id=?').run(asset.id, ownerId);
      deleted++;
      console.log(`已删除：${asset.storage_key} (${asset.id})`);
    }
    console.log(`已删除 ${deleted} 个未引用资源。`);
  }
} finally {
  if (db) await db.close();
  if (storage) await storage.close();
}
