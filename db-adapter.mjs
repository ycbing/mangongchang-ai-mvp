import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

function pgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export async function openDatabase({ databaseUrl, databasePath }) {
  if (databaseUrl) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: 'mangongchang-ai' });
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
  async function locked(fn) { const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous; try { return fn(); } finally { release(); } }
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
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const file = resolve(migrationsDir, '001_initial.sql');
  const sql = await readFile(file, 'utf8');
  await db.transaction(async tx => {
    const applied = await tx.prepare('SELECT version FROM schema_migrations WHERE version=?').get('001_initial');
    if (applied) return;
    await tx.exec?.(sql);
    if (!tx.exec) {
      // Statements in the migration contain no procedural blocks; send them individually.
      for (const statement of sql.split(';').map(x => x.trim()).filter(Boolean)) await tx.prepare(statement).run();
    }
    await tx.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run('001_initial', Date.now());
  });
}
