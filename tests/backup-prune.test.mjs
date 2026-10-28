import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pruneScript = join(root, 'scripts', 'prune-backups.mjs');

function timestampName(date) {
  return `mangongchang-${date.toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
}

async function createBackup(backupRoot, date, { corrupt = false, symlinkManifest = false } = {}) {
  const directory = join(backupRoot, timestampName(date));
  await mkdir(directory, { recursive: true });
  const data = {
    'database.dump': Buffer.from(`dump-${date.toISOString()}`),
    'assets.tar.gz': Buffer.from(`assets-${date.toISOString()}`),
  };
  const files = [];
  for (const [name, bytes] of Object.entries(data)) {
    const path = join(directory, name);
    await writeFile(path, bytes);
    files.push({ file: name, sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (corrupt) files[0].sha256 = '0'.repeat(64);
  const manifest = JSON.stringify({ format: 'mangongchang-backup-v1', createdAt: date.toISOString(), files });
  const manifestPath = join(directory, 'manifest.json');
  const sourcePath = join(backupRoot, `${timestampName(date)}.manifest-source`);
  await writeFile(sourcePath, manifest);
  if (symlinkManifest) await symlink(sourcePath, manifestPath);
  else await writeFile(manifestPath, manifest);
  return directory;
}

function runPrune(backupRoot, args = []) {
  return execFileSync(process.execPath, [pruneScript, ...args], {
    cwd: root,
    env: { ...process.env, BACKUP_DIR: backupRoot },
    encoding: 'utf8',
  });
}

test('backup pruning defaults to preview, then removes only backups outside retention count and age', async () => {
  const backupRoot = await mkdtemp(join(tmpdir(), 'mangongchang-prune-'));
  try {
    const now = Date.now();
    const directories = [];
    for (let daysOld = 91; daysOld <= 106; daysOld++) {
      directories.push(await createBackup(backupRoot, new Date(now - daysOld * 86400_000)));
    }

    const preview = runPrune(backupRoot);
    assert.match(preview, /预览模式：已识别 16 个有效备份/);
    assert.match(preview, /mangongchang-/);
    assert.equal((await readdir(backupRoot)).filter(name => name.endsWith('Z')).length, 16);

    const applied = runPrune(backupRoot, ['--apply']);
    assert.match(applied, /已清理 2 个备份/);
    for (const directory of directories.slice(0, 14)) await readFile(join(directory, 'manifest.json'));
    await assert.rejects(readFile(join(directories[14], 'manifest.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directories[15], 'manifest.json')), { code: 'ENOENT' });
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
});

test('backup pruning skips checksum-mismatched and symlink manifests', async () => {
  const backupRoot = await mkdtemp(join(tmpdir(), 'mangongchang-prune-'));
  try {
    const now = Date.now();
    for (let daysOld = 1; daysOld <= 14; daysOld++) {
      await createBackup(backupRoot, new Date(now - daysOld * 86400_000));
    }
    const corrupt = await createBackup(backupRoot, new Date(now - 110 * 86400_000), { corrupt: true });
    const linked = await createBackup(backupRoot, new Date(now - 111 * 86400_000), { symlinkManifest: true });

    const output = runPrune(backupRoot, ['--apply']);
    assert.match(output, /SHA-256 校验失败/);
    assert.match(output, /缺少安全的 manifest\.json/);
    await readFile(join(corrupt, 'manifest.json'));
    await readFile(join(linked, 'manifest.json'));
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
});
