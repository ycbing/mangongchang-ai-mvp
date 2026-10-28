export function boundedInteger(name, fallback, min, max, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(String(raw))) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function validateProductionAuth(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const password = env.AUTH_PASSWORD || '';
  if (!password) throw new Error('AUTH_PASSWORD is required in production');
  if ([...password].length < 16) throw new Error('AUTH_PASSWORD must contain at least 16 characters in production');
}

export function validateProductionDatabase(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const databaseUrl = env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required in production; configure PostgreSQL');
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use PostgreSQL in production');
}
