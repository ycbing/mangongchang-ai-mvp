const queueName = 'mangongchang-ai-jobs';

export async function createJobQueue({ redisUrl, concurrency = 2, processJob }) {
  if (!redisUrl) return { kind: 'in-process', async enqueue() {}, async close() {} };

  const [{ Queue, Worker }, redisModule] = await Promise.all([import('bullmq'), import('ioredis')]);
  const Redis = redisModule.default;
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  connection.on('error', error => console.error(JSON.stringify({ component: 'redis', code: error.code || 'REDIS_ERROR' })));
  const queue = new Queue(queueName, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1500 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  workerConnection.on('error', error => console.error(JSON.stringify({ component: 'redis-worker', code: error.code || 'REDIS_ERROR' })));
  const worker = new Worker(queueName, async job => processJob(job.data.jobId), { connection: workerConnection, concurrency });
  worker.on('failed', (job, error) => console.error(JSON.stringify({ component: 'job-worker', jobId: job?.data?.jobId, code: error.code || 'JOB_PROCESS_ERROR' })));
  worker.on('error', error => console.error(JSON.stringify({ component: 'job-worker', code: error.code || 'WORKER_ERROR' })));

  let readyTimer;
  try {
    await Promise.race([
      Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]),
      new Promise((_, reject) => { readyTimer = setTimeout(() => reject(Object.assign(new Error('Redis startup timed out'), { code: 'REDIS_STARTUP_TIMEOUT' })), 15000); }),
    ]);
  } catch (error) {
    await Promise.allSettled([worker.close(true), queue.close()]);
    workerConnection.disconnect();
    connection.disconnect();
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
  return {
    kind: 'bullmq',
    async enqueue(job) {
      await queue.add(job.type, { jobId: job.id }, { jobId: job.id });
    },
    async close() {
      try {
        await worker.close();
        await queue.close();
        await Promise.all([workerConnection.quit(), connection.quit()]);
      } catch (error) {
        workerConnection.disconnect();
        connection.disconnect();
        throw error;
      }
    },
  };
}
