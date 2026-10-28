CREATE INDEX IF NOT EXISTS exports_owner_work_created
  ON exports(owner_id, work_id, created_at DESC);
