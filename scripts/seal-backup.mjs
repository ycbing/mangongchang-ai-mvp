import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { encryptBackupFile, readBackupKey } from '../backup-encryption.mjs';
import './env.mjs';

const exec = promisify(execFile);
const [directoryArg, outputArg] = process.argv.slice(2);
if (!directoryArg || !outputArg) throw new Error('用法：npm run backup:seal -- <备份目录> <加密文件路径>');
const directory = resolve(directoryArg), output = resolve(outputArg), keyFile = process.env.BACKUP_KEY_FILE || '';
const directoryInfo = await lstat(directory);
if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('备份输入路径必须是实际目录，不能是符号链接。');
const outputRelative = relative(directory, output);
if (!outputRelative || outputRelative === '..' || !outputRelative.startsWith(`..${sep}`)) throw new Error('加密文件必须保存到备份目录之外。');
if (!keyFile) throw new Error('请通过 BACKUP_KEY_FILE 指定单独保管的 32 字节密钥文件。');
const manifestPath = join(directory, 'manifest.json');
const manifestInfo = await lstat(manifestPath);
if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('备份清单必须是普通文件。');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.format !== 'mangongchang-backup-v1' || !Array.isArray(manifest.files)) throw new Error('输入目录不是有效的漫工厂备份。');
const expectedNames = new Set(manifest.files.map(file => file.file));
if (expectedNames.size !== manifest.files.length || expectedNames.has('manifest.json')) throw new Error('备份清单包含重复或保留文件名。');
if (!expectedNames.has('database.dump') || !expectedNames.has('assets.tar.gz')) throw new Error('备份缺少数据库或图片归档文件。');
for (const file of manifest.files) {
  if (typeof file.file !== 'string' || basename(file.file) !== file.file || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('备份清单格式无效。');
  const path = join(directory, file.file), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== file.sizeBytes) throw new Error(`备份文件缺失、不是普通文件或大小不匹配：${file.file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== file.sha256) throw new Error(`备份文件校验失败：${file.file}`);
}
const actualNames = (await readdir(directory)).filter(name => name !== 'manifest.json');
if (actualNames.length !== expectedNames.size || actualNames.some(name => !expectedNames.has(name))) throw new Error('备份目录中的文件与清单不一致。');
const key = await readBackupKey(keyFile);
const scratch = await mkdtemp(join(tmpdir(), 'mangongchang-backup-seal-'));
const archive = join(scratch, 'backup.tar.gz');
try {
  await exec('tar', ['-czf', archive, '-C', directory, '.']);
  await encryptBackupFile(archive, output, key);
  console.log(`已校验并加密备份：${output}`);
} finally { await rm(scratch, { recursive: true, force: true }); }
