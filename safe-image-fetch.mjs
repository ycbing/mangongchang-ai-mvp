import https from 'node:https';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113;
}

function ipv4Mapped(address) {
  const normalized = address.toLowerCase();
  const dotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const pieces = normalized.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [], right = pieces[1] ? pieces[1].split(':') : [];
  const words = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].map(value => Number.parseInt(value || '0', 16));
  if (words.length !== 8 || words.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) return null;
  const mapped = words.slice(0, 5).every(value => value === 0) && words[5] === 0xffff;
  const compatible = words.slice(0, 6).every(value => value === 0);
  if (!mapped && !compatible) return null;
  const high = words[6], low = words[7];
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;
  const mapped = ipv4Mapped(address);
  if (mapped) return isPrivateIpv4(mapped);
  const words = address.toLowerCase().split(':');
  // Publicly routable IPv6 unicast addresses use the 2000::/3 global range.
  const first = Number.parseInt(words[0] || '0', 16);
  if ((first & 0xe000) !== 0x2000) return true;
  const second = Number.parseInt(words[1] || '0', 16);
  return first === 0x2002 || first === 0x2001 && [0, 2, 0x10, 0x20, 0xdb8].includes(second);
}

export function createPinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    if (options?.all) return callback(null, addresses);
    const address = addresses.find(item => !options?.family || item.family === options.family) || addresses[0];
    callback(null, address.address, address.family);
  };
}

function requestPinned(url, addresses, signal) {
  return new Promise((resolveRequest, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const request = https.request({
      protocol: 'https:', hostname, port: url.port || 443, path: `${url.pathname}${url.search}`,
      method: 'GET', headers: { accept: 'image/png,image/jpeg,image/webp' },
      lookup: createPinnedLookup(addresses), servername: isIP(hostname) ? undefined : hostname,
      signal, timeout: 15_000, maxHeaderSize: 16 * 1024,
    }, resolveRequest);
    request.on('timeout', () => request.destroy(new Error('图片下载超时')));
    request.on('error', reject);
    request.end();
  });
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw Object.assign(new Error('生成图片超过大小限制'), { code: 'IMAGE_SIZE_LIMIT' });
  }
  const chunks = []; let total = 0;
  for await (const value of response) {
    const chunk = Buffer.from(value); total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw Object.assign(new Error('生成图片超过大小限制'), { code: 'IMAGE_SIZE_LIMIT' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function safeImageFetch(value, signal, maxBytes, dependencies = {}) {
  let url;
  try { if (typeof value !== 'string' || value.length > 8192) throw new Error(); url = new URL(value); } catch { throw new Error('绘图模型返回的图片地址无效'); }
  const resolveHost = dependencies.lookup || lookup, request = dependencies.request || requestPinned;
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port && Number(url.port) !== 443) throw new Error('绘图模型图片地址必须使用 HTTPS');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) throw new Error('绘图模型图片地址无效');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolveHost(hostname, { all: true, verbatim: true }).catch(() => []);
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('绘图模型图片地址无法安全访问');
    const response = await request(url, addresses, signal);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      if (redirects === 4) throw new Error('图片下载重定向次数过多');
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error('图片地址重定向无效');
      url = new URL(location, url);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); return { ok: false, status: response.statusCode }; }
    return { ok: true, status: response.statusCode, contentType: response.headers['content-type'] || '', bytes: await readBounded(response, maxBytes) };
  }
  throw new Error('图片下载失败');
}
