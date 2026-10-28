import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { boundedInteger } from './runtime-config.mjs';

function pgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export async function openDatabase({ databaseUrl, databasePath }) {
  if (databaseUrl) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: boundedInteger('PG_POOL_MAX', 10, 1, 100), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: 'mangongchang-ai' });
    await pool.query('SELECT 1');
    return {
      kind: 'postgres',
      prepare(sql) {
        const text = pgSql(sql);
        return {
          async get(...params) { return (await pool.query(text, params)).rows[0]; },
          async all(...params) { return (await pool.query(text, params)).rows; },
          async run(...params) { const result = await pool.query(text, params); return { changes: result.rowCount }; },
        };
      },
      async exec(sql) { await pool.query(sql); },
      async transaction(callback) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx = { exec: async sql => { await client.query(sql); }, prepare(sql) { const text = pgSql(sql); return { get: async (...params) => (await client.query(text, params)).rows[0], all: async (...params) => (await client.query(text, params)).rows, run: async (...params) => ({ changes: (await client.query(text, params)).rowCount }) }; } };
          const result = await callback(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      async close() { await pool.end(); },
    };
  }
  await mkdir(dirname(resolve(databasePath)), { recursive: true });
  const sqlite = new DatabaseSync(databasePath);
  let queue = Promise.resolve();
  async function locked(fn) { const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous; try { return await fn(); } finally { release(); } }
  return {
    kind: 'sqlite',
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return { get: (...params) => locked(() => statement.get(...params)), all: (...params) => locked(() => statement.all(...params)), run: (...params) => locked(() => statement.run(...params)) };
    },
    exec(sql) { return locked(() => sqlite.exec(sql)); },
    transaction(callback) {
      return locked(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        const tx = { prepare(sql) { const statement = sqlite.prepare(sql); return { get: (...params) => statement.get(...params), all: (...params) => statement.all(...params), run: (...params) => statement.run(...params) }; }, exec(sql) { return sqlite.exec(sql); } };
        try { const result = await callback(tx); sqlite.exec('COMMIT'); return result; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
    },
    close() { sqlite.close(); },
  };
}

export async function applyPostgresMigrations(db, migrationsDir) {
  const files = (await readdir(migrationsDir))
    .filter(name => /^\d{3,}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((a, b) => {
      const left = BigInt(a.slice(0, a.indexOf('_'))), right = BigInt(b.slice(0, b.indexOf('_')));
      return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
  if (!files.length) throw new Error('PostgreSQL migration directory contains no versioned SQL files');
  for (let i = 1; i < files.length; i++) {
    if (files[i - 1].slice(0, files[i - 1].indexOf('_')) === files[i].slice(0, files[i].indexOf('_'))) {
      throw new Error(`Duplicate PostgreSQL migration version: ${files[i].slice(0, files[i].indexOf('_'))}`);
    }
  }
  const migrations = await Promise.all(files.map(async name => {
    const version = name.slice(0, -4), sql = await readFile(resolve(migrationsDir, name), 'utf8');
    if (!sql.trim()) throw new Error(`PostgreSQL migration ${version} is empty`);
    return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));

  await db.transaction(async tx => {
    // Lock before creating the tracking table so simultaneous app startup is safe too.
    await tx.prepare('SELECT pg_advisory_xact_lock(?)').get(1179466577);
    await tx.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL, checksum TEXT)');
    await tx.exec('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
    for (const { version, sql, checksum } of migrations) {
      const applied = await tx.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(version);
      if (applied) {
        if (applied.checksum && applied.checksum !== checksum) throw new Error(`Applied PostgreSQL migration has changed: ${version}`);
        if (!applied.checksum) await tx.prepare('UPDATE schema_migrations SET checksum=? WHERE version=? AND checksum IS NULL').run(checksum, version);
        continue;
      }
      await tx.exec(sql);
      await tx.prepare('INSERT INTO schema_migrations(version,applied_at,checksum) VALUES(?,?,?)').run(version, Date.now(), checksum);
    }
  });
}
