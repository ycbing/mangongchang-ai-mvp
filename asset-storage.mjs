import { createHash } from 'node:crypto';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

function validKey(key) {
  const value = String(key || '');
  if (!value || value !== value.split(/[\\/]/).at(-1) || value.startsWith('.') || !/^[a-zA-Z0-9-]+\.(?:png|jpg|webp)$/.test(value)) throw new Error('资源存储键无效');
  return value;
}

export async function openAssetStorage({ directory, s3Sdk: suppliedS3Sdk } = {}) {
  const bucket = process.env.S3_BUCKET || '';
  if (!bucket) {
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    return {
      kind: 'local',
      async put(key, bytes) { const target = resolve(root, validKey(key)); if (!target.startsWith(root + sep)) throw new Error('资源路径无效'); await writeFile(target, bytes, { flag: 'wx' }); },
      async get(key, maxBytes = Infinity) { const bytes = await readFile(join(root, validKey(key))); if (bytes.byteLength > maxBytes) throw new Error('资源文件超过读取限制'); return bytes; },
      async health() { try { await access(root, constants.R_OK | constants.W_OK); return true; } catch { return false; } },
      async inspect(key) { try { const bytes = await readFile(join(root, validKey(key))); return { exists: true, checksum: createHash('sha256').update(bytes).digest('hex') }; } catch (error) { if (error.code === 'ENOENT') return { exists: false, checksum: null }; throw error; } },
      async delete(key) { try { await unlink(join(root, validKey(key))); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
      async close() {},
    };
  }

  const region = process.env.S3_REGION || 'us-east-1';
  const endpoint = process.env.S3_ENDPOINT || undefined;
  if ((process.env.S3_ACCESS_KEY_ID && !process.env.S3_SECRET_ACCESS_KEY) || (!process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)) throw new Error('S3_ACCESS_KEY_ID 与 S3_SECRET_ACCESS_KEY 必须同时设置');
  if (endpoint) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('S3_ENDPOINT 必须是无账号信息的 HTTP 或 HTTPS 地址');
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production' && !['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)) throw new Error('生产环境的远程 S3_ENDPOINT 必须使用 HTTPS');
  }
  const { S3Client, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = suppliedS3Sdk || await import('@aws-sdk/client-s3');
  const credentials = process.env.S3_ACCESS_KEY_ID ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } : undefined;
  const client = new S3Client({ region, endpoint, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', credentials });
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  return {
    kind: 's3',
    async health() { try { await client.send(new HeadBucketCommand({ Bucket: bucket })); return true; } catch { return false; } },
    async put(key, bytes, mimeType) {
      const value = validKey(key), checksum = createHash('sha256').update(bytes).digest('hex');
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: value, Body: bytes, ContentType: mimeType, CacheControl: 'private, max-age=86400', Metadata: { sha256: checksum } }));
    },
    async get(key, maxBytes = Infinity) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: validKey(key) }));
      if (Number(result.ContentLength || 0) > maxBytes) throw new Error('资源文件超过读取限制');
      const chunks = []; let total = 0;
      for await (const chunk of result.Body) { const bytes = Buffer.from(chunk); total += bytes.byteLength; if (total > maxBytes) throw new Error('资源文件超过读取限制'); chunks.push(bytes); }
      const bytes = Buffer.concat(chunks), expected = result.Metadata?.sha256;
      if (expected && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected))) throw Object.assign(new Error('S3 图片校验元数据无效'), { code: 'OBJECT_CHECKSUM_INVALID' });
      if (expected && createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) throw Object.assign(new Error('S3 图片 SHA-256 校验失败'), { code: 'OBJECT_CHECKSUM_MISMATCH' });
      return bytes;
    },
    async inspect(key) {
      try { const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: validKey(key) })); return { exists: true, checksum: result.Metadata?.sha256 || null }; }
      catch (error) { if (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.Code === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return { exists: false, checksum: null }; throw error; }
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: validKey(key) })); },
    async close() { client.destroy(); },
  };
}
