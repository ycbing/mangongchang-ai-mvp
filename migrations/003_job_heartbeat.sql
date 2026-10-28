ALTER TABLE jobs ADD COLUMN IF NOT EXISTS heartbeat_at BIGINT;

CREATE INDEX IF NOT EXISTS jobs_owner_running_heartbeat
  ON jobs(owner_id, status, heartbeat_at)
  WHERE status IN ('running', 'cancel_requested');
