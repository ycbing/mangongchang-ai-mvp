const queueName = 'mangongchang-ai-jobs';

export async function createJobQueue({ redisUrl, concurrency = 2, processJob, role = 'combined' }) {
  if (!['combined', 'web', 'worker'].includes(role)) throw new Error(`Unsupported service role: ${role}`);
  if (!redisUrl) {
    if (role !== 'combined') throw new Error(`SERVICE_ROLE=${role} requires REDIS_URL`);
    return { kind: 'in-process', async enqueue() {}, async health() { return true; }, async close() {} };
  }

  const [{ Queue, Worker }, redisModule] = await Promise.all([import('bullmq'), import('ioredis')]);
  const Redis = redisModule.default;
  const resources = [];
  let queue, worker, producerConnection, workerConnection;
  try {
    if (role !== 'worker') {
      producerConnection = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: true });
      producerConnection.on('error', error => console.error(JSON.stringify({ component: 'redis-producer', code: error.code || 'REDIS_ERROR' })));
      queue = new Queue(queueName, { connection: producerConnection, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1500 }, removeOnComplete: true, removeOnFail: true } });
      resources.push(queue.waitUntilReady());
    }
    if (role !== 'web') {
      workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
      workerConnection.on('error', error => console.error(JSON.stringify({ component: 'redis-worker', code: error.code || 'REDIS_ERROR' })));
      worker = new Worker(queueName, async job => processJob(job.data.jobId), { connection: workerConnection, concurrency });
      worker.on('failed', (job, error) => console.error(JSON.stringify({ component: 'job-worker', jobId: job?.data?.jobId, code: error.code || 'JOB_PROCESS_ERROR' })));
      worker.on('error', error => console.error(JSON.stringify({ component: 'job-worker', code: error.code || 'WORKER_ERROR' })));
      resources.push(worker.waitUntilReady());
    }
    let readyTimer;
    try {
      await Promise.race([
        Promise.all(resources),
        new Promise((_, reject) => { readyTimer = setTimeout(() => reject(Object.assign(new Error('Redis startup timed out'), { code: 'REDIS_STARTUP_TIMEOUT' })), 15000); }),
      ]);
    } finally { clearTimeout(readyTimer); }
  } catch (error) {
    await Promise.allSettled([worker?.close(true), queue?.close()]);
    workerConnection?.disconnect();
    producerConnection?.disconnect();
    throw error;
  }
  const connections = [producerConnection, workerConnection].filter(Boolean);
  return {
    kind: 'bullmq',
    role,
    async health() {
      try { return connections.length > 0 && (await Promise.all(connections.map(connection => connection.ping()))).every(value => value === 'PONG'); }
      catch { return false; }
    },
    async enqueue(job) {
      if (!queue) throw new Error('This service role cannot enqueue jobs');
      await queue.add(job.type, { jobId: job.id }, { jobId: job.id });
    },
    async close() {
      const closing = await Promise.allSettled([worker?.close(), queue?.close()]);
      await Promise.allSettled(connections.map(connection => connection.quit()));
      const failure = closing.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}
