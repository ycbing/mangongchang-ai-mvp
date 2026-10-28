import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('MGBAKENC');
const VERSION = 1;
const HEADER_SIZE = MAGIC.length + 1 + 12;
const TAG_SIZE = 16;

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('备份加密密钥必须为 32 字节。');
}

function assertDistinctPaths(input, output) {
  if (resolve(input) === resolve(output)) throw new Error('输入和输出路径不能相同。');
}

async function publishWithoutOverwrite(tempPath, outputPath) {
  await link(tempPath, outputPath);
  await rm(tempPath, { force: true });
}

function tempOutputPath(outputPath) {
  return `${resolve(outputPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

export async function encryptBackupFile(inputPath, outputPath, key) {
  assertKey(key);
  assertDistinctPaths(inputPath, outputPath);
  const input = resolve(inputPath), output = resolve(outputPath), temporary = tempOutputPath(output);
  await stat(input);
  await mkdir(dirname(output), { recursive: true });
  const nonce = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), nonce]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const appendTag = new Transform({ transform(chunk, encoding, callback) { callback(null, chunk); }, flush(callback) {
    try { this.push(cipher.getAuthTag()); callback(); } catch (error) { callback(error); }
  } });
  try {
    await writeFile(temporary, header, { flag: 'wx', mode: 0o600 });
    await pipeline(createReadStream(input), cipher, appendTag, createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
    await publishWithoutOverwrite(temporary, output);
    return output;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function decryptBackupFile(inputPath, outputPath, key) {
  assertKey(key);
  assertDistinctPaths(inputPath, outputPath);
  const input = resolve(inputPath), output = resolve(outputPath), temporary = tempOutputPath(output);
  const info = await stat(input);
  if (!info.isFile() || info.size < HEADER_SIZE + TAG_SIZE) throw new Error('加密备份文件格式无效或已损坏。');
  const handle = await open(input, 'r');
  let header, tag;
  try {
    header = Buffer.alloc(HEADER_SIZE);
    tag = Buffer.alloc(TAG_SIZE);
    const headerRead = await handle.read(header, 0, HEADER_SIZE, 0);
    const tagRead = await handle.read(tag, 0, TAG_SIZE, info.size - TAG_SIZE);
    if (headerRead.bytesRead !== HEADER_SIZE || tagRead.bytesRead !== TAG_SIZE) throw new Error('加密备份文件格式无效或已损坏。');
  } finally { await handle.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== VERSION) throw new Error('不支持的加密备份格式。');
  await mkdir(dirname(output), { recursive: true });
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length + 1));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(input, { start: HEADER_SIZE, end: info.size - TAG_SIZE - 1 }), decipher, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await publishWithoutOverwrite(temporary, output);
    return output;
  } catch (error) {
    await rm(temporary, { force: true });
    if (error.code === 'ERR_OSSL_EVP_BAD_DECRYPT' || /authenticate|bad decrypt/i.test(error.message)) throw new Error('备份认证失败：密钥不正确或文件已被篡改。');
    throw error;
  }
}

export async function readBackupKey(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('备份密钥路径必须是普通文件。');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('备份密钥文件权限过宽；请设置为仅当前用户可读写（0600）。');
  const key = await readFile(path);
  assertKey(key);
  return key;
}
