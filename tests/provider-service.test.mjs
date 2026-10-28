import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderService } from '../provider-service.mjs';

function storyboard(count = 1) {
  return {
    title: '一段漫画',
    summary: '测试分镜',
    panels: Array.from({ length: count }, (_, index) => ({
      scene: `场景 ${index + 1}`, action: '人物向前走', camera: '中景', expression: '平静',
      dialogue: '', caption: '', sfx: '', imagePrompt: '暖色二维漫画', negativePrompt: '文字和水印', tone: 'hope',
    })),
  };
}

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

test('provider service reports mock mode without credentials', async () => {
  const service = createProviderService({ config: { llmProvider: 'mock', imageProvider: 'mock' }, maxImageBytes: 100, saveImageAsset: async () => {} });
  assert.deepEqual(service.safeConfig(), {
    llm: { provider: 'mock', model: null },
    image: { provider: 'mock', model: null },
  });
  assert.deepEqual(await service.callStoryboard({}, new AbortController().signal), { mode: 'mock' });
  assert.deepEqual(await service.callImageProvider({}, new AbortController().signal), { mode: 'mock' });
});

test('storyboard provider validates output shape and repairs one malformed response', async () => {
  const calls = [];
  const service = createProviderService({
    config: { llmProvider: 'openai-compatible', llmBaseUrl: 'https://models.example/v1/', llmApiKey: 'test-secret', llmModel: 'test-model', imageProvider: 'mock' },
    maxImageBytes: 100,
    saveImageAsset: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return responseJson({ choices: [{ message: { content: 'not JSON' } }] });
      return responseJson({ choices: [{ message: { content: JSON.stringify(storyboard(2)) } }] });
    },
  });
  const result = await service.callStoryboard({ panelCount: 2, title: '测试作品', premise: '测试故事' }, new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://models.example/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-secret');
  assert.equal(result.mode, 'ai');
  assert.equal(result.panels.length, 2);
  assert.equal(result.panels[0].scene, '场景 1');
  assert.equal(result.panels[0].index, 0);
});

test('storyboard provider bounds response size and reports upstream HTTP errors', async () => {
  const config = { llmProvider: 'openai-compatible', llmBaseUrl: 'https://models.example/v1', llmApiKey: 'secret', llmModel: 'model' };
  const service = createProviderService({ config, maxImageBytes: 100, saveImageAsset: async () => {}, fetchImpl: async () => new Response('unavailable', { status: 503 }) });
  await assert.rejects(service.callStoryboard({}, undefined), { status: 503 });

  const oversized = createProviderService({ config, maxImageBytes: 100, saveImageAsset: async () => {}, fetchImpl: async () => new Response('x'.repeat(2_000_001)) });
  await assert.rejects(oversized.callStoryboard({}, undefined), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
});

test('image provider stores base64 and safely fetched HTTPS results through the asset adapter', async () => {
  const saved = [];
  const config = { imageProvider: 'openai-compatible', imageBaseUrl: 'https://models.example/v1', imageApiKey: 'secret', imageModel: 'image-model', imageSize: '1024x1536' };
  const imageBytes = Buffer.from('image-fixture');
  const base64Service = createProviderService({
    config, maxImageBytes: 100, saveImageAsset: async (...args) => { saved.push(args); return { assetId: 'asset-1', imageUrl: '/assets/asset-1.png' }; },
    fetchImpl: async () => responseJson({ data: [{ b64_json: imageBytes.toString('base64') }] }),
  });
  const result = await base64Service.callImageProvider({ workId: 'work-1', panelId: 'panel-1', prompt: '小废柴在办公室' }, undefined);
  assert.equal(result.mode, 'ai');
  assert.equal(result.assetId, 'asset-1');
  assert.deepEqual(saved[0][0], imageBytes);
  assert.equal(saved[0][1], 'image/png');

  const remoteService = createProviderService({
    config, maxImageBytes: 100, saveImageAsset: async (...args) => { saved.push(args); return { assetId: 'asset-2' }; },
    fetchImpl: async () => responseJson({ data: [{ url: 'https://images.example/panel.png' }] }),
    fetchImage: async url => ({ ok: true, contentType: 'image/webp', bytes: Buffer.from(url) }),
  });
  const remote = await remoteService.callImageProvider({ workId: 'work-1', panelId: 'panel-2', prompt: '下班场景' }, undefined);
  assert.equal(remote.assetId, 'asset-2');
  assert.equal(saved[1][1], 'image/webp');
  assert.equal(saved[1][2].panelId, 'panel-2');
});
