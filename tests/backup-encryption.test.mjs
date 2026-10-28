import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decryptBackupFile, encryptBackupFile, readBackupKey } from '../backup-encryption.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

test('backup encryption round-trips data and refuses to overwrite existing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-crypto-'));
  const input = join(directory, 'source.tar.gz'), sealed = join(directory, 'backup.mgbak'), restored = join(directory, 'restored.tar.gz');
  const data = randomBytes(256 * 1024 + 17), key = randomBytes(32);
  try {
    await writeFile(input, data);
    await encryptBackupFile(input, sealed, key);
    assert.equal((await stat(sealed)).mode & 0o777, 0o600);
    assert.notDeepEqual(await readFile(sealed), data);
    await decryptBackupFile(sealed, restored, key);
    assert.deepEqual(await readFile(restored), data);
    await assert.rejects(encryptBackupFile(input, sealed, key), /EEXIST/);
    await assert.rejects(decryptBackupFile(sealed, restored, key), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('backup decryption rejects a wrong key and authenticated tampering without publishing plaintext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-crypto-'));
  const input = join(directory, 'source.tar.gz'), sealed = join(directory, 'backup.mgbak'), wrongOutput = join(directory, 'wrong.tar.gz'), tampered = join(directory, 'tampered.mgbak'), tamperedOutput = join(directory, 'tampered.tar.gz');
  try {
    await writeFile(input, Buffer.from('database and asset backup payload'));
    const key = randomBytes(32);
    await encryptBackupFile(input, sealed, key);
    await assert.rejects(decryptBackupFile(sealed, wrongOutput, randomBytes(32)), /认证失败/);
    await assert.rejects(stat(wrongOutput), { code: 'ENOENT' });
    const bytes = await readFile(sealed);
    bytes[bytes.length - 20] ^= 0x01;
    await writeFile(tampered, bytes);
    await assert.rejects(decryptBackupFile(tampered, tamperedOutput, key), /认证失败/);
    await assert.rejects(stat(tamperedOutput), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('backup key reader requires a 32-byte key file with private permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-key-'));
  const keyPath = join(directory, 'backup.key');
  try {
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    await chmod(keyPath, 0o600);
    assert.equal((await readBackupKey(keyPath)).length, 32);
    await chmod(keyPath, 0o644);
    if (process.platform !== 'win32') await assert.rejects(readBackupKey(keyPath), /权限过宽/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('backup seal and unseal commands verify the manifest and produce a readable archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mangongchang-seal-cli-'));
  const backup = join(directory, 'mangongchang-2026-01-01'), keyPath = join(directory, 'backup.key');
  const sealed = join(directory, 'offsite.mgbak'), restored = join(directory, 'restored.tar.gz');
  try {
    await mkdir(backup);
    const entries = [];
    for (const [index, name] of ['database.dump', 'assets.tar.gz'].entries()) {
      const data = Buffer.from(index ? 'asset archive fixture' : 'postgres dump fixture');
      await writeFile(join(backup, name), data);
      entries.push({ file: name, sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
    await writeFile(join(backup, 'manifest.json'), JSON.stringify({ format: 'mangongchang-backup-v1', files: entries }));
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
    await chmod(keyPath, 0o600);
    const env = { ...process.env, BACKUP_KEY_FILE: keyPath };
    const sealScript = new URL('../scripts/seal-backup.mjs', import.meta.url).pathname;
    const unsealScript = new URL('../scripts/unseal-backup.mjs', import.meta.url).pathname;
    await exec(process.execPath, [sealScript, backup, sealed], { cwd: root, env });
    await exec(process.execPath, [unsealScript, sealed, restored], { cwd: root, env });
    const { stdout } = await exec('tar', ['-tzf', restored]);
    assert.match(stdout, /database\.dump/);
    assert.match(stdout, /assets\.tar\.gz/);
    await assert.rejects(exec(process.execPath, [unsealScript, sealed, restored], { cwd: root, env }), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
