import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { root } from './env.mjs';

const apply = process.argv.includes('--apply');
const keepArg = process.argv.find(value => value.startsWith('--keep='));
const ageArg = process.argv.find(value => value.startsWith('--retention-days='));
const keep = keepArg ? Number(keepArg.slice('--keep='.length)) : 14;
const retentionDays = ageArg ? Number(ageArg.slice('--retention-days='.length)) : 90;
const allowedArgs = new Set(['--apply', ...(keepArg ? [keepArg] : []), ...(ageArg ? [ageArg] : [])]);
const unknown = process.argv.slice(2).filter(value => !allowedArgs.has(value));
if (unknown.length) throw new Error(`不支持的参数：${unknown.join(' ')}`);
if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error('--keep 必须是 1–1000 之间的整数');
if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) throw new Error('--retention-days 必须是 7–3650 之间的整数');

const backupRoot = resolve(process.env.BACKUP_DIR || join(root, 'data', 'backups'));
const rootStat = await lstat(backupRoot).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
if (!rootStat) {
  console.log(`备份目录不存在，无需清理：${backupRoot}`);
  process.exit(0);
}
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('备份目录必须是实际目录，不能是符号链接。');
const canonicalRoot = await realpath(backupRoot);
const now = Date.now();
const backups = [];
const skipped = [];
const directoryPattern = /^mangongchang-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
  if (!directoryPattern.test(entry.name)) continue;
  const directory = join(canonicalRoot, entry.name);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) { skipped.push(`${entry.name}（不是普通目录）`); continue; }
  const manifestPath = join(directory, 'manifest.json');
  const manifestInfo = await lstat(manifestPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) { skipped.push(`${entry.name}（缺少安全的 manifest.json）`); continue; }

  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { skipped.push(`${entry.name}（manifest.json 无法读取）`); continue; }
  const createdAt = Date.parse(manifest.createdAt);
  if (manifest.format !== 'mangongchang-backup-v1' || !Number.isFinite(createdAt) || createdAt > now || !Array.isArray(manifest.files)) {
    skipped.push(`${entry.name}（备份清单格式或时间无效）`); continue;
  }
  const listedFiles = new Map(manifest.files.map(file => [file.file, file]));
  let valid = manifest.files.length === 2 && listedFiles.size === 2 && ['database.dump', 'assets.tar.gz'].every(name => listedFiles.has(name));
  let sizeBytes = manifestInfo.size;
  const files = [];
  for (const [name, file] of listedFiles) {
    if (!['database.dump', 'assets.tar.gz'].includes(name) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) { valid = false; break; }
    const path = join(directory, name);
    const fileInfo = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!fileInfo?.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== file.sizeBytes) { valid = false; break; }
    sizeBytes += fileInfo.size;
    files.push({ path, expectedSha256: file.sha256 });
  }
  if (!valid) { skipped.push(`${entry.name}（备份文件与清单不匹配）`); continue; }
  if (!directory.startsWith(canonicalRoot + sep)) throw new Error('清理路径越界，已停止。');
  backups.push({ name: entry.name, directory, createdAt, sizeBytes, files });
}

backups.sort((a, b) => b.createdAt - a.createdAt);
const pruneCandidates = backups.filter((backup, index) => index >= keep && now - backup.createdAt >= retentionDays * 86400_000);
const prune = [];
for (const backup of pruneCandidates) {
  let checksumsMatch = true;
  for (const file of backup.files) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    if (hash.digest('hex') !== file.expectedSha256) { checksumsMatch = false; break; }
  }
  if (checksumsMatch) prune.push(backup);
  else skipped.push(`${backup.name}（SHA-256 校验失败）`);
}
console.log(`${apply ? '清理模式' : '预览模式'}：已识别 ${backups.length} 个有效备份；保留最新 ${keep} 个，且只清理超过 ${retentionDays} 天的备份。`);
if (!prune.length) console.log('没有符合清理条件的备份。');
for (const backup of prune) {
  const ageDays = Math.floor((now - backup.createdAt) / 86400_000);
  console.log(`${backup.name} | ${ageDays} 天 | ${(backup.sizeBytes / 1_000_000).toFixed(2)} MB`);
  if (apply) await rm(backup.directory, { recursive: true, force: false });
}
for (const item of skipped) console.log(`跳过：${item}`);
if (apply) console.log(`已清理 ${prune.length} 个备份。`);
else console.log('预览模式未删除任何文件；核对清单后使用 npm run backup:prune -- --apply 执行清理。');
