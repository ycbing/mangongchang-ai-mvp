import { randomUUID } from 'node:crypto';

function mapExport(row) {
  return {
    id: row.id,
    workId: row.work_id,
    jobId: row.job_id,
    format: row.format,
    width: Number(row.width),
    height: Number(row.height),
    sliceCount: Number(row.slice_count),
    assetIds: JSON.parse(row.asset_ids_json),
    status: row.status,
    options: JSON.parse(row.options_json),
    createdAt: Number(row.created_at),
  };
}

export async function createCompletedExport(db, { ownerId, workId, assetIds, width, height, options = {}, idempotencyKey = null }) {
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 20 || assetIds.some(id => typeof id !== 'string') || new Set(assetIds).size !== assetIds.length) {
    throw Object.assign(new Error('导出图片列表无效'), { status: 422, code: 'VALIDATION_ERROR' });
  }
  if (!Number.isInteger(width) || width < 1 || width > 4096 || !Number.isInteger(height) || height < 1 || height > 400_000) {
    throw Object.assign(new Error('导出图片尺寸无效'), { status: 422, code: 'VALIDATION_ERROR' });
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) || Buffer.byteLength(JSON.stringify(options)) > 4000) {
    throw Object.assign(new Error('导出设置无效'), { status: 422, code: 'VALIDATION_ERROR' });
  }

  let outcome;
  await db.transaction(async tx => {
    if (idempotencyKey) {
      const prior = await tx.prepare('SELECT id,type,input_json FROM jobs WHERE owner_id=? AND idempotency_key=?').get(ownerId, idempotencyKey);
      if (prior) {
        const priorInput = JSON.parse(prior.input_json);
        if (prior.type !== 'export' || priorInput.workId !== workId) throw Object.assign(new Error('幂等键已用于其他任务或作品'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
        const row = await tx.prepare('SELECT * FROM exports WHERE owner_id=? AND job_id=?').get(ownerId, prior.id);
        if (!row) throw Object.assign(new Error('导出记录正在创建，请稍后重试'), { status: 409, code: 'EXPORT_IN_PROGRESS' });
        outcome = mapExport(row);
        return;
      }
    }

    const assets = [];
    for (const assetId of assetIds) {
      const asset = await tx.prepare('SELECT id,size_bytes FROM assets WHERE id=? AND owner_id=? AND work_id=? AND kind=?').get(assetId, ownerId, workId, 'export_slice');
      if (!asset) throw Object.assign(new Error('导出图片不存在或不属于当前作品'), { status: 422, code: 'VALIDATION_ERROR' });
      assets.push(asset);
    }
    if (assets.reduce((total, asset) => total + Number(asset.size_bytes), 0) > 100_000_000) {
      throw Object.assign(new Error('本次导出文件总量超过 100 MB'), { status: 422, code: 'EXPORT_SIZE_LIMIT' });
    }

    const now = Date.now(), jobId = randomUUID(), exportId = randomUUID();
    const jobInput = { workId, assetIds, format: 'png', width, height, options: { ...options, clientRendered: true } };
    const result = { exportId, assetIds, format: 'png', width, height, sliceCount: assetIds.length };
    await tx.prepare(`INSERT INTO jobs(id,owner_id,type,status,progress,input_json,result_json,error_json,idempotency_key,previous_job_id,attempts,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(jobId, ownerId, 'export', 'succeeded', 100, JSON.stringify(jobInput), JSON.stringify(result), null, idempotencyKey, null, 0, now, now, now);
    await tx.prepare('INSERT INTO exports(id,owner_id,work_id,job_id,format,width,height,slice_count,asset_ids_json,status,options_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(exportId, ownerId, workId, jobId, 'png', width, height, assetIds.length, JSON.stringify(assetIds), 'succeeded', JSON.stringify(jobInput.options), now);
    outcome = { id: exportId, workId, jobId, format: 'png', width, height, sliceCount: assetIds.length, assetIds, status: 'succeeded', options: jobInput.options, createdAt: now };
  });
  return outcome;
}

export async function listWorkExports(db, ownerId, workId) {
  const rows = await db.prepare('SELECT * FROM exports WHERE owner_id=? AND work_id=? ORDER BY created_at DESC LIMIT 100').all(ownerId, workId);
  return rows.map(mapExport);
}
