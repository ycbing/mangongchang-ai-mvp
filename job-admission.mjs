export async function insertJobsWithinLimit(db, ownerId, jobs) {
  await db.transaction(async tx => {
    if (db.kind === 'postgres') await tx.prepare('SELECT pg_advisory_xact_lock(73210001)').get();
    const active = Number((await tx.prepare("SELECT count(*) n FROM jobs WHERE owner_id=? AND status IN ('queued','running','cancel_requested')").get(ownerId)).n);
    if (active + jobs.length > 20) throw Object.assign(new Error(`当前待处理任务为 ${active} 个；本次 ${jobs.length} 个任务会超过 20 个上限`), { status: 429, code: 'QUEUE_LIMIT' });
    const insert = tx.prepare('INSERT INTO jobs(id,owner_id,type,status,progress,input_json,idempotency_key,previous_job_id,attempts,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const job of jobs) await insert.run(job.id, ownerId, job.type, job.status, 0, JSON.stringify(job.input), job.idempotencyKey || null, job.previousJobId || null, job.attempts || 0, job.createdAt);
  });
}
