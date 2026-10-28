import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const integrationUrl = process.env.PG_RACE_TEST_URL || '';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitUntilReady(child, baseUrl, recordOutput) {
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; recordOutput(chunk); });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; recordOutput(chunk); });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited before ready: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) { await response.arrayBuffer(); return; }
      await response.arrayBuffer();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`Server did not become ready: ${output}`);
}

test('character patch returns 409 when another PostgreSQL process commits after its revision check', {
  skip: !integrationUrl && 'Set PG_RACE_TEST_URL to a PostgreSQL admin URL with CREATEDB permission to run this isolated multi-process integration test.',
}, async t => {
  const database = `mgc_race_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: integrationUrl });
  const databaseUrl = new URL(integrationUrl);
  databaseUrl.pathname = `/${database}`;
  databaseUrl.searchParams.delete('options');
  let child, scopedAdmin, lockHeld = false, databaseCreated = false, serverOutput = '';
  const testDir = await mkdtemp(join(tmpdir(), 'mangongchang-character-race-'));
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_URL: databaseUrl.toString(),
        DATABASE_PATH: join(testDir, 'unused.sqlite'),
        LOCAL_STORAGE_DIR: join(testDir, 'assets'),
        REDIS_URL: '',
        AUTH_PASSWORD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUntilReady(child, baseUrl, chunk => { serverOutput += chunk; });

    const stateResponse = await fetch(`${baseUrl}/api/v1/state`);
    const initial = await stateResponse.json();
    const character = initial.state.characters[0];
    assert.ok(character, 'application should start with its sample character');

    scopedAdmin = new Client({ connectionString: databaseUrl.toString() });
    await scopedAdmin.connect();
    const assetId = randomUUID();
    await scopedAdmin.query(
      `INSERT INTO assets(id,owner_id,kind,storage_key,mime_type,width,height,size_bytes,checksum,metadata_json,created_at)
       VALUES($1,'local-owner','character_ref','race-check.png','image/png',1,1,1,$2,'{}',$3)`,
      [assetId, '0'.repeat(64), Date.now()],
    );
    await scopedAdmin.query('BEGIN');
    await scopedAdmin.query('LOCK TABLE assets IN ACCESS EXCLUSIVE MODE');
    lockHeld = true;

    const patchPromise = fetch(`${baseUrl}/api/v1/characters/${encodeURIComponent(character.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '竞态下不应写入', referenceAssetIds: [assetId], revision: initial.revision }),
    }).then(async response => ({ status: response.status, body: await response.json() })).catch(error => ({ requestError: error }));

    let requestBlocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const activity = await scopedAdmin.query(
        `SELECT activity.pid FROM pg_stat_activity activity
         JOIN pg_locks waiting ON waiting.pid=activity.pid AND NOT waiting.granted
         JOIN pg_class relation ON relation.oid=waiting.relation
         WHERE activity.application_name='mangongchang-ai' AND activity.wait_event_type='Lock'
           AND relation.relname='assets'`,
      );
      if (activity.rowCount) { requestBlocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    let earlyOutcome;
    let activityDetails;
    if (!requestBlocked) {
      earlyOutcome = await Promise.race([patchPromise, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
      activityDetails = (await scopedAdmin.query(
        'SELECT application_name,wait_event_type,state,left(query,200) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
      )).rows;
      activityDetails.push(...(await scopedAdmin.query(
        `SELECT blocked.query AS blocked_query, blocker.query AS blocker_query,
                waiting.locktype, waiting.relation::regclass::text AS relation, waiting.mode
         FROM pg_stat_activity blocked
         JOIN pg_locks waiting ON waiting.pid=blocked.pid AND NOT waiting.granted
         CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker_pid(pid)
         JOIN pg_stat_activity blocker ON blocker.pid=blocker_pid.pid
         WHERE blocked.datname=current_database()`,
      )).rows);
    }
    assert.ok(requestBlocked, `PATCH should pass its early revision check and wait on the locked asset lookup; response=${JSON.stringify(earlyOutcome)} activity=${JSON.stringify(activityDetails)}`);

    const current = await scopedAdmin.query('SELECT revision,snapshot FROM app_state WHERE id=1');
    const nextRevision = Number(current.rows[0].revision) + 1;
    await scopedAdmin.query('UPDATE app_state SET revision=$1,updated_at=$2 WHERE id=1', [nextRevision, Date.now()]);
    await scopedAdmin.query('INSERT INTO state_history(revision,snapshot,created_at) VALUES($1,$2,$3)', [nextRevision, current.rows[0].snapshot, Date.now()]);
    await scopedAdmin.query('COMMIT');
    lockHeld = false;

    const outcome = await patchPromise;
    assert.equal(outcome.requestError, undefined);
    assert.equal(outcome.status, 409);
    assert.equal(outcome.body.error?.code, 'REVISION_CONFLICT');
    assert.equal(outcome.body.character, undefined);
    const latest = await (await fetch(`${baseUrl}/api/v1/state`)).json();
    assert.equal(latest.revision, nextRevision);
    assert.equal(latest.state.characters.find(item => item.id === character.id).name, character.name);
  } finally {
    if (lockHeld) await scopedAdmin?.query('ROLLBACK').catch(() => {});
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      let shutdownTimer;
      const exited = await Promise.race([once(child, 'exit').then(() => true), new Promise(resolve => { shutdownTimer = setTimeout(() => resolve(false), 12_000); })]);
      clearTimeout(shutdownTimer);
      if (!exited) child.kill('SIGKILL');
      assert.ok(exited, `application did not gracefully exit after SIGTERM; ${serverOutput}`);
      assert.equal(child.exitCode, 0, `application exited unsuccessfully after SIGTERM; ${serverOutput}`);
    }
    await scopedAdmin?.end().catch(() => {});
    if (databaseCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
    await rm(testDir, { recursive: true, force: true });
  }
});
