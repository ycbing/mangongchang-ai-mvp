export async function persistSnapshot(db, snapshot, expectedRevision, syncProjection) {
  let outcome;
  await db.transaction(async tx => {
    const current = await tx.prepare(`SELECT revision,snapshot FROM app_state WHERE id=1${db.kind === 'postgres' ? ' FOR UPDATE' : ''}`).get();
    const actual = Number(current.revision);
    if (Number(expectedRevision) !== actual) {
      outcome = { conflict: true, revision: actual, snapshot: JSON.parse(current.snapshot) };
      return;
    }
    const nextRevision = actual + 1, now = Date.now(), json = JSON.stringify(snapshot);
    await tx.prepare('UPDATE app_state SET revision=?,snapshot=?,updated_at=? WHERE id=1').run(nextRevision, json, now);
    await tx.prepare('INSERT INTO state_history(revision,snapshot,created_at) VALUES(?,?,?)').run(nextRevision, json, now);
    await syncProjection(snapshot, tx);
    await tx.prepare('DELETE FROM state_history WHERE revision NOT IN (SELECT revision FROM state_history ORDER BY revision DESC LIMIT 50)').run();
    outcome = { revision: nextRevision };
  });
  return outcome;
}

export async function mutateSnapshot(db, mutator, syncProjection, onCommitted = () => {}, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await db.prepare('SELECT revision,snapshot FROM app_state WHERE id=1').get();
    if (!current) throw new Error('作品状态尚未初始化');
    const snapshot = JSON.parse(current.snapshot), result = mutator(snapshot);
    if (result === false) return { result, revision: Number(current.revision) };
    const persisted = await persistSnapshot(db, snapshot, Number(current.revision), syncProjection);
    if (!persisted.conflict) {
      onCommitted(snapshot, persisted.revision);
      return { result, revision: persisted.revision };
    }
  }
  throw Object.assign(new Error('作品正在被其他操作更新，请稍后重试'), { status: 409, code: 'REVISION_CONFLICT' });
}
