import sharp from 'sharp';
import './comic-art.js';

const MAX_OUTPUT_BYTES = 100_000_000;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

export function normalizeExportOptions(options = {}) {
  const width = Number(options.width), maxHeight = Number(options.maxHeight), gutter = Number(options.gutter);
  const widthOptions = new Set([750, 900, 1080]), heightOptions = new Set([8000, 12000, 20000]);
  if (!widthOptions.has(width) || !heightOptions.has(maxHeight) || !Number.isInteger(gutter) || gutter < 0 || gutter > 100) {
    throw Object.assign(new Error('导出宽度、高度或格间距无效'), { code: 'INVALID_EXPORT_OPTIONS' });
  }
  const ratio = Array.isArray(options.ratio) ? options.ratio.map(Number) : String(options.ratio || '4/5').split('/').map(Number);
  if (ratio.length !== 2 || ratio.some(value => !Number.isInteger(value) || value < 1 || value > 5)) {
    throw Object.assign(new Error('导出画幅比例无效'), { code: 'INVALID_EXPORT_OPTIONS' });
  }
  const background = /^#[0-9a-f]{6}$/i.test(options.background || '') ? options.background : '#f6f4ed';
  return { width, maxHeight, gutter, ratio, background };
}

function splitLines(text, maxChars, maxLines) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    let line = '';
    for (const character of paragraph) {
      if (line && [...line].length >= maxChars) { lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = [...lines[maxLines - 1]].slice(0, Math.max(1, maxChars - 1)).join('') + '…';
  }
  return lines;
}

function textBlock(text, layout, defaults, width, height, style) {
  if (typeof text !== 'string' || !text) return '';
  text = text.slice(0, 1000);
  const x = clamp(layout?.x, 0, 0.98, defaults.x), y = clamp(layout?.y, 0, 0.98, defaults.y);
  const w = clamp(layout?.w, 0.02, 1 - x, defaults.w), h = clamp(layout?.h, 0.02, 1 - y, defaults.h);
  const left = Math.round(x * width), top = Math.round(y * height), boxWidth = Math.max(1, Math.round(w * width)), boxHeight = Math.max(1, Math.round(h * height));
  const padding = Math.max(5, Math.round(width * (style === 'dialogue' ? 0.035 : 0.025)));
  const fontSize = Math.max(12, Math.round(width / 360 * (style === 'dialogue' ? 19 : 15))), lineHeight = Math.round(fontSize * 1.42);
  const maxChars = Math.max(1, Math.floor((boxWidth - padding * 2) / (fontSize * 1.05)));
  const maxLines = Math.max(1, Math.floor((boxHeight - padding * 2) / lineHeight));
  const lines = splitLines(text, maxChars, maxLines);
  const textLines = lines.map((line, index) => `<tspan x="${left + padding}" dy="${index ? lineHeight : 0}">${escapeXml(line)}</tspan>`).join('');
  const fill = style === 'dialogue' ? '#fffef8' : '#fffdf0e8';
  const radius = style === 'dialogue' ? Math.min(boxWidth, boxHeight) * 0.42 : Math.max(4, width * 0.02);
  const outline = style === 'dialogue' ? '<rect' : '<rect';
  return `${outline} x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" rx="${Math.round(radius)}" fill="${fill}" ${style === 'dialogue' ? 'stroke="#30342d" stroke-width="2"' : ''}/><text x="${left + padding}" y="${top + padding + fontSize}" font-family="Noto Sans CJK SC, Noto Sans, sans-serif" font-size="${fontSize}" font-weight="600" fill="#20231f">${textLines}</text>`;
}

function textOverlay(panel, width, height) {
  const content = textBlock(panel.dialogue, panel.dialogueLayout, { x: 0.07, y: 0.07, w: 0.54, h: 0.18 }, width, height, 'dialogue')
    + textBlock(panel.caption, panel.captionLayout, { x: 0.08, y: 0.82, w: 0.8, h: 0.1 }, width, height, 'caption');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`);
}

async function imagePanel(bytes, panel, width, height, background) {
  const oriented = await sharp(bytes, { limitInputPixels: 24_000_000, failOn: 'warning' }).rotate().toBuffer();
  const metadata = await sharp(oriented, { limitInputPixels: 24_000_000, failOn: 'warning' }).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > 24_000_000) throw Object.assign(new Error('画格图片尺寸无效或过大'), { code: 'INVALID_PANEL_IMAGE' });
  const fit = ['contain', 'stretch'].includes(panel.fit) ? panel.fit : 'cover';
  let pipeline = sharp(oriented, { limitInputPixels: 24_000_000, failOn: 'warning' });
  if (fit === 'stretch') pipeline = pipeline.resize(width, height, { fit: 'fill' });
  else if (fit === 'contain') pipeline = pipeline.resize(width, height, { fit: 'contain', background });
  else {
    const targetRatio = width / height, sourceRatio = metadata.width / metadata.height;
    const focal = { x: clamp(panel.focalPoint?.x, 0, 1, 0.5), y: clamp(panel.focalPoint?.y, 0, 1, 0.5) };
    if (sourceRatio > targetRatio) {
      const cropWidth = Math.max(1, Math.min(metadata.width, Math.round(metadata.height * targetRatio)));
      pipeline = pipeline.extract({ left: Math.round((metadata.width - cropWidth) * focal.x), top: 0, width: cropWidth, height: metadata.height });
    } else {
      const cropHeight = Math.max(1, Math.min(metadata.height, Math.round(metadata.width / targetRatio)));
      pipeline = pipeline.extract({ left: 0, top: Math.round((metadata.height - cropHeight) * focal.y), width: metadata.width, height: cropHeight });
    }
    pipeline = pipeline.resize(width, height, { fit: 'fill' });
  }
  const resized = await pipeline.png().toBuffer();
  return sharp(resized).composite([{ input: textOverlay(panel, width, height) }]).png().toBuffer();
}

async function mockPanel(panel, index, width, height) {
  const art = globalThis.mangongchangComicSvgArt?.(panel, index);
  if (!art) throw new Error('演示画面模板尚未载入');
  const background = await sharp(Buffer.from(art), { limitInputPixels: 1_000_000 }).resize(width, height, { fit: 'fill' }).png().toBuffer();
  return sharp(background).composite([{ input: textOverlay(panel, width, height) }]).png().toBuffer();
}

export async function renderComicExports({ work, options, loadImage, signal, onProgress = async () => {} }) {
  const normalized = normalizeExportOptions(options), [ratioWidth, ratioHeight] = normalized.ratio;
  const contentWidth = normalized.width - normalized.gutter * 2;
  if (contentWidth < 1 || !Array.isArray(work?.panels) || work.panels.length < 1 || work.panels.length > 20) throw Object.assign(new Error('作品画格或画布设置无效'), { code: 'INVALID_WORK' });
  const panelHeight = Math.round(contentWidth * ratioHeight / ratioWidth);
  const groups = []; let group = [], groupHeight = normalized.gutter * 2;
  for (let index = 0; index < work.panels.length; index++) {
    const nextHeight = panelHeight + normalized.gutter;
    if (group.length && groupHeight + nextHeight > normalized.maxHeight) { groups.push(group); group = []; groupHeight = normalized.gutter; }
    group.push({ panel: work.panels[index], index }); groupHeight += nextHeight;
  }
  if (group.length) groups.push(group);

  const slices = []; let outputBytes = 0, panelStart = 0;
  for (const entries of groups) {
    if (signal?.aborted) throw Object.assign(new Error('导出任务已取消'), { name: 'AbortError' });
    const height = normalized.gutter + entries.length * (panelHeight + normalized.gutter);
    const layers = []; let top = normalized.gutter;
    for (const { panel, index } of entries) {
      if (signal?.aborted) throw Object.assign(new Error('导出任务已取消'), { name: 'AbortError' });
      const image = await loadImage(panel);
      const rendered = image ? await imagePanel(image, panel, contentWidth, panelHeight, normalized.background) : await mockPanel(panel, index, contentWidth, panelHeight);
      layers.push({ input: rendered, left: normalized.gutter, top }); top += panelHeight + normalized.gutter;
      panelStart++;
      await onProgress(panelStart, work.panels.length);
    }
    const buffer = await sharp({ create: { width: normalized.width, height, channels: 4, background: normalized.background } })
      .composite(layers).png({ compressionLevel: 8, adaptiveFiltering: true }).toBuffer();
    outputBytes += buffer.byteLength;
    if (outputBytes > MAX_OUTPUT_BYTES) throw Object.assign(new Error('导出图片总量超过 100 MB，请降低宽度或拆分作品'), { code: 'EXPORT_SIZE_LIMIT' });
    slices.push({ buffer, width: normalized.width, height, panelStart: panelStart - entries.length + 1, panelEnd: panelStart });
  }
  return { slices, width: normalized.width, height: slices.reduce((sum, slice) => sum + slice.height, 0), options: normalized };
}
