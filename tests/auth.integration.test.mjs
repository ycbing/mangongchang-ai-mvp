import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const accessPassword = 'test-only-production-password-32-chars';

test('production server refuses to start without PostgreSQL configuration', async () => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', AUTH_PASSWORD: accessPassword, DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output, /DATABASE_URL is required in production/);
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('auth enforces same-origin writes and emits secure session cookies when requested', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-auth-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AUTH_COOKIE_SECURE: 'true',
      AUTH_PASSWORD: accessPassword,
      DATABASE_URL: '',
      DATABASE_PATH: join(directory, 'test.sqlite'),
      LOCAL_STORAGE_DIR: join(directory, 'assets'),
      REDIS_URL: '',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const request = (path, init = {}) => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { connection: 'close', ...init.headers },
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited before ready: ${output}`);
      try {
        const response = await request('/api/v1/auth/status');
        if (response.ok) { await response.arrayBuffer(); ready = true; break; }
        await response.arrayBuffer();
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Server did not become ready: ${output}`);

    const page = await request('/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    await page.arrayBuffer();

    const unauthenticated = await request('/api/v1/state');
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(unauthenticated.headers.get('x-frame-options'), 'DENY');
    assert.equal(unauthenticated.headers.get('referrer-policy'), 'same-origin');
    assert.equal(unauthenticated.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    await unauthenticated.arrayBuffer();

    const readiness = await request('/healthz');
    assert.equal(readiness.status, 200);
    assert.deepEqual(await readiness.json(), { status: 'ok' });
    const privateHealth = await request('/api/v1/health');
    assert.equal(privateHealth.status, 401);
    await privateHealth.arrayBuffer();

    const crossOriginLogin = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ password: accessPassword }),
    });
    assert.equal(crossOriginLogin.status, 403);
    await crossOriginLogin.arrayBuffer();

    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ password: accessPassword }),
    });
    assert.equal(login.status, 200);
    const cookieHeader = login.headers.get('set-cookie') || '';
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Strict/);
    assert.match(cookieHeader, /Secure/);
    const cookie = cookieHeader.split(';', 1)[0];
    await login.arrayBuffer();

    const state = await request('/api/v1/state', { headers: { cookie } });
    assert.equal(state.status, 200);
    const initialState = await state.json();

    const crossOriginWrite = await request('/api/v1/state', {
      method: 'PUT',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ works: [], characters: [], revision: 1 }),
    });
    assert.equal(crossOriginWrite.status, 403);
    await crossOriginWrite.arrayBuffer();

    const invalidStateWrite = await request('/api/v1/state', {
      method: 'PUT',
      headers: { cookie, origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ works: [], characters: [], activeId: 'missing-work', revision: 1 }),
    });
    assert.equal(invalidStateWrite.status, 422);
    assert.equal((await invalidStateWrite.json()).error.code, 'VALIDATION_ERROR');
    const afterRejectedWrite = await request('/api/v1/state', { headers: { cookie } });
    assert.equal((await afterRejectedWrite.json()).revision, initialState.revision);

    const logout = await request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: baseUrl },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
    await logout.arrayBuffer();

    for (let attempt = 0; attempt < 10; attempt++) {
      const bad = await request('/api/v1/auth/login', {
        method: 'POST',
        headers: { origin: baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'incorrect password' }),
      });
      assert.equal(bad.status, 401);
      await bad.arrayBuffer();
    }
    const rateLimited = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ password: accessPassword }),
    });
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.headers.get('retry-after'), '900');
    await rateLimited.arrayBuffer();
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      let shutdownTimer;
      const exited = await Promise.race([once(child, 'exit').then(() => true), new Promise(resolve => { shutdownTimer = setTimeout(() => resolve(false), 12_000); })]);
      clearTimeout(shutdownTimer);
      if (!exited) child.kill('SIGKILL');
      assert.ok(exited, `Server did not gracefully exit after SIGTERM: ${output}`);
      assert.equal(child.exitCode, 0, `Server exited unsuccessfully: ${output}`);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
