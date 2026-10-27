import { join } from 'node:path';
import { root } from './env.mjs';
import { openDatabase, applyPostgresMigrations } from '../db-adapter.mjs';
if (!process.env.DATABASE_URL) throw new Error('请先在 .env 中设置 DATABASE_URL');
const db = await openDatabase({ databaseUrl: process.env.DATABASE_URL, databasePath: '' });
try {
  await applyPostgresMigrations(db, join(root, 'migrations'));
  console.log('PostgreSQL 数据库迁移完成。');
} finally { await db.close(); }
