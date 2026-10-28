const baseUrl = process.env.CI_APP_URL || 'http://127.0.0.1:4173';
const password = process.env.CI_AUTH_PASSWORD || '';
if (!password) throw new Error('CI_AUTH_PASSWORD is required for the Compose smoke test.');

const readiness = await fetch(`${baseUrl}/healthz`);
if (!readiness.ok) throw new Error(`Unauthenticated readiness probe failed: HTTP ${readiness.status}`);
const readinessBody = await readiness.json();
if (readinessBody.status !== 'ok' || Object.keys(readinessBody).some(key => key !== 'status')) throw new Error('Readiness probe must return only the minimal ready status.');

const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
  method: 'POST',
  headers: { origin: baseUrl, 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
});
if (!login.ok) throw new Error(`Compose login failed: HTTP ${login.status}`);
const setCookie = login.headers.get('set-cookie') || '';
if (!/; Secure/i.test(setCookie) || !/HttpOnly/i.test(setCookie) || !/SameSite=Strict/i.test(setCookie)) throw new Error('Production session cookie flags are incomplete.');
const cookie = setCookie.split(';', 1)[0];

const healthResponse = await fetch(`${baseUrl}/api/v1/health`, { headers: { cookie } });
if (!healthResponse.ok) throw new Error(`Authenticated health check failed: HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
if (health.storage !== 'postgres' || health.queue !== 'bullmq' || health.status !== 'ok') throw new Error(`Compose dependencies are not ready: ${JSON.stringify(health)}`);

console.log('Compose smoke: production authentication and PostgreSQL/BullMQ health passed.');

// Exercise the same work -> storyboard flow used by the product UI. This also
// verifies that work state and its queued job are visible across app processes.
const workResponse = await fetch(`${baseUrl}/api/v1/works`, {
  method: 'POST',
  headers: { cookie, origin: baseUrl, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'CI 队列验收', premise: '跨进程任务端到端冒烟', panelCount: 2 }),
});
if (workResponse.status !== 201) throw new Error(`Could not create a smoke-test work: HTTP ${workResponse.status} ${await workResponse.text()}`);
const { work } = await workResponse.json();
if (!work?.id) throw new Error('Work API did not return a work ID.');

const created = await fetch(`${baseUrl}/api/v1/works/${encodeURIComponent(work.id)}/storyboards`, {
  method: 'POST',
  headers: { cookie, origin: baseUrl, 'content-type': 'application/json' },
  body: JSON.stringify({}),
});
if (created.status !== 202) throw new Error(`Could not enqueue a storyboard job: HTTP ${created.status} ${await created.text()}`);
const createdJob = await created.json();
const jobId = createdJob.jobId || createdJob.id;
if (!jobId) throw new Error(`Storyboard API did not return a job ID: ${JSON.stringify(createdJob)}`);
console.log(`Compose smoke: created work ${work.id} and queued storyboard job ${jobId}.`);

let job;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const response = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`, { headers: { cookie } });
  if (!response.ok) throw new Error(`Could not poll worker job: HTTP ${response.status}`);
  job = await response.json();
  if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (job?.status !== 'succeeded' || job.result?.mode !== 'mock') throw new Error(`Cross-container worker job did not succeed: ${JSON.stringify(job)}`);
console.log(`Compose smoke passed: PostgreSQL, BullMQ worker, production auth, and storyboard job ${jobId}.`);
