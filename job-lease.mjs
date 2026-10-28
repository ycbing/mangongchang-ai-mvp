export async function heartbeatRunningJob(db, ownerId, jobId, now = Date.now()) {
  return db.prepare("UPDATE jobs SET heartbeat_at=? WHERE id=? AND owner_id=? AND status='running'").run(now, jobId, ownerId);
}

export async function recoverExpiredJobs(db, ownerId, staleBefore) {
  let requeued = 0, cancelled = 0;
  await db.transaction(async tx => {
    const reset = await tx.prepare("UPDATE jobs SET status='queued',started_at=NULL,heartbeat_at=NULL,finished_at=NULL,progress=0 WHERE owner_id=? AND status='running' AND COALESCE(heartbeat_at,started_at)<?").run(ownerId, staleBefore);
    const stopped = await tx.prepare("UPDATE jobs SET status='cancelled',heartbeat_at=NULL,finished_at=? WHERE owner_id=? AND status='cancel_requested' AND COALESCE(heartbeat_at,started_at)<?").run(Date.now(), ownerId, staleBefore);
    requeued = reset.changes;
    cancelled = stopped.changes;
  });
  return { requeued, cancelled };
}
