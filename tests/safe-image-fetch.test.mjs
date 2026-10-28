import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPinnedLookup, isPrivateAddress, safeImageFetch } from '../safe-image-fetch.mjs';

function response(statusCode, headers = {}, chunks = []) {
  const stream = Readable.from(chunks);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

test('SSRF address filter rejects private, reserved, mapped, and local IPv6 addresses', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '100.64.0.1', '172.20.0.1', '169.254.169.254', '192.168.1.2', '224.0.0.1', '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1', '::ffff:c0a8:101', '2001:db8::1', '2001:0db8::1', '2001:20::1', '2002:0808:0808::1']) {
    assert.equal(isPrivateAddress(address), true, `${address} should be denied`);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(address), false, `${address} should be permitted`);
});

test('pinned DNS lookup returns only the addresses already validated by the SSRF filter', () => {
  const vetted = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  const lookup = createPinnedLookup(vetted);
  lookup('images.example.test', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  lookup('images.example.test', { family: 6 }, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, vetted[1].address); assert.equal(family, 6);
  });
  lookup('images.example.test', { all: true }, (error, addresses) => {
    assert.equal(error, null); assert.deepEqual(addresses, vetted);
  });
});

test('safe image fetch pins HTTPS requests to validated DNS results and rechecks redirects', async () => {
  let resolved = 0, requested = 0;
  const result = await safeImageFetch('https://images.example.test/panel.png', new AbortController().signal, 100, {
    lookup: async host => { resolved++; assert.equal(host, 'images.example.test'); return [{ address: '8.8.8.8', family: 4 }]; },
    request: async (url, addresses) => { requested++; assert.equal(url.hostname, 'images.example.test'); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); return response(200, { 'content-type': 'image/png', 'content-length': '4' }, [Buffer.from('PNG!')]); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.bytes.toString(), 'PNG!');
  assert.equal(resolved, 1);
  assert.equal(requested, 1);

  let redirectRequests = 0;
  await assert.rejects(safeImageFetch('https://images.example.test/start', undefined, 100, {
    lookup: async () => [{ address: '8.8.4.4', family: 4 }],
    request: async () => { redirectRequests++; return response(302, { location: 'https://127.0.0.1/latest' }); },
  }), /无法安全访问/);
  assert.equal(redirectRequests, 1, 'the private redirect target must never receive a request');
});

test('safe image fetch rejects oversized bodies before returning image bytes', async () => {
  let destroyed = false;
  const oversized = response(200, { 'content-type': 'image/png' }, [Buffer.alloc(8)]);
  const originalDestroy = oversized.destroy.bind(oversized);
  oversized.destroy = (...args) => { destroyed = true; return originalDestroy(...args); };
  await assert.rejects(safeImageFetch('https://images.example.test/panel.png', undefined, 4, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => oversized,
  }), { code: 'IMAGE_SIZE_LIMIT' });
  assert.equal(destroyed, true);
});
