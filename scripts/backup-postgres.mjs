import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { root } from './env.mjs';

const databaseUrl = process.env.DATABASE_URL || '';
if (!databaseUrl) throw new Error('DATABASE_URL 未设置；此命令只备份 PostgreSQL。');
if (process.env.S3_BUCKET) throw new Error('检测到 S3_BUCKET。请先使用对象存储自身的版本控制/复制策略备份图片，再单独备份 PostgreSQL。');

const backupRoot = resolve(process.env.BACKUP_DIR || join(root, 'data', 'backups'));
const assetDirectory = resolve(process.env.LOCAL_STORAGE_DIR || join(root, 'data', 'assets'));
const connection = new URL(databaseUrl);
if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('DATABASE_URL 必须使用 PostgreSQL URL。');
const databaseHost = connection.hostname.replace(/^\[|\]$/g, '') || 'localhost';
const databasePort = connection.port || '5432';
const databaseName = decodeURIComponent(connection.pathname.slice(1));
const databaseUser = decodeURIComponent(connection.username);
if (!databaseName || !databaseUser) throw new Error('DATABASE_URL 必须包含数据库名和用户名。');
const optionEnvironment = new Map([
  ['application_name', 'PGAPPNAME'], ['channel_binding', 'PGCHANNELBINDING'], ['connect_timeout', 'PGCONNECT_TIMEOUT'],
  ['gssencmode', 'PGGSSENCMODE'], ['keepalives', 'PGKEEPALIVES'], ['keepalives_count', 'PGKEEPALIVES_COUNT'],
  ['keepalives_idle', 'PGKEEPALIVES_IDLE'], ['keepalives_interval', 'PGKEEPALIVES_INTERVAL'], ['options', 'PGOPTIONS'],
  ['sslcert', 'PGSSLCERT'], ['sslcrl', 'PGSSLCRL'], ['sslcrldir', 'PGSSLCRLDIR'], ['sslkey', 'PGSSLKEY'],
  ['sslmode', 'PGSSLMODE'], ['sslpassword', 'PGSSLPASSWORD'], ['sslrootcert', 'PGSSLROOTCERT'],
  ['target_session_attrs', 'PGTARGETSESSIONATTRS'], ['tcp_user_timeout', 'PGTCP_USER_TIMEOUT'],
]);
const pgEnvironment = {
  ...process.env,
  PGHOST: databaseHost,
  PGPORT: databasePort,
  PGDATABASE: databaseName,
  PGUSER: databaseUser,
  PGAPPNAME: 'mangongchang-backup',
};
delete pgEnvironment.DATABASE_URL;
delete pgEnvironment.PGPASSWORD;
for (const [key, envName] of optionEnvironment) if (connection.searchParams.has(key)) pgEnvironment[envName] = connection.searchParams.get(key);
const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const outputDirectory = join(backupRoot, `mangongchang-${timestamp}`);
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
await mkdir(outputDirectory, { mode: 0o700 });
await chmod(outputDirectory, 0o700);
const credentialDirectory = await mkdtemp(join(tmpdir(), 'mangongchang-pg-backup-'));
const passwordFile = join(credentialDirectory, 'pgpass');

function run(command, args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun() : reject(new Error(`${command} 失败（退出码 ${code}）：${stderr.replaceAll(databaseUrl, '[数据库连接信息已隐藏]').trim()}`)));
  });
}

try {
  if (connection.password) {
    const escapePassfile = value => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
    await writeFile(passwordFile, `${[databaseHost, databasePort, databaseName, databaseUser, decodeURIComponent(connection.password)].map(escapePassfile).join(':')}\n`, { mode: 0o600 });
    await chmod(passwordFile, 0o600);
    pgEnvironment.PGPASSFILE = passwordFile;
  }
  const databaseFile = join(outputDirectory, 'database.dump');
  const assetsFile = join(outputDirectory, 'assets.tar.gz');
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', databaseFile], pgEnvironment);
  const assetInfo = await stat(assetDirectory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (assetInfo?.isDirectory()) await run('tar', ['-czf', assetsFile, '-C', assetDirectory, '.']);
  else {
    const emptyDirectory = join(outputDirectory, '.empty-assets');
    await mkdir(emptyDirectory, { mode: 0o700 });
    await run('tar', ['-czf', assetsFile, '-C', emptyDirectory, '.']);
    await rm(emptyDirectory, { recursive: true });
  }

  const files = [];
  for (const name of await readdir(outputDirectory)) {
    const path = join(outputDirectory, name), info = await stat(path);
    if (!info.isFile()) continue;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    files.push({ file: name, sizeBytes: info.size, sha256: hash.digest('hex') });
    await chmod(path, 0o600);
  }
  const manifest = {
    format: 'mangongchang-backup-v1',
    createdAt: new Date().toISOString(),
    database: 'postgresql-custom-dump',
    assetStorage: 'local-directory',
    files,
  };
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`备份完成：${outputDirectory}`);
  for (const file of files) console.log(`${file.file} | ${file.sizeBytes} B | SHA-256 ${file.sha256}`);
} catch (error) {
  await rm(outputDirectory, { recursive: true, force: true });
  throw error;
} finally {
  await rm(credentialDirectory, { recursive: true, force: true });
}
