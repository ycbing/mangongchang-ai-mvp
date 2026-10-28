import sharp from 'sharp';

const MAX_IMAGE_PIXELS = 24_000_000;
const MAX_IMAGE_DIMENSION = 10_000;

export async function verifyImage(bytes, mime) {
  const buffer = Buffer.from(bytes);
  const png = buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer.length > 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const webp = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!((mime === 'image/png' && png) || (mime === 'image/jpeg' && jpeg) || (mime === 'image/webp' && webp))) {
    throw Object.assign(new Error('图片文件内容与类型不一致'), { code: 'INVALID_IMAGE' });
  }
  let metadata;
  try { metadata = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).metadata(); }
  catch { throw Object.assign(new Error('图片无法解码或尺寸超出限制'), { code: 'INVALID_IMAGE' }); }
  const formats = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
  if (formats[metadata.format] !== mime || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
      || metadata.width < 1 || metadata.height < 1 || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION
      || metadata.width * metadata.height > MAX_IMAGE_PIXELS || (metadata.pages || 1) > 1) {
    throw Object.assign(new Error('图片格式、帧数或尺寸不受支持'), { code: 'INVALID_IMAGE' });
  }
  return { width: metadata.width, height: metadata.height };
}
