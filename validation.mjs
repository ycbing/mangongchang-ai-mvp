function validationError(message) {
  return Object.assign(new Error(message), { status: 422, code: 'VALIDATION_ERROR' });
}

export function validateCanvasSettings(value, fallback = { ratio: '4/5', gutter: 16, bg: '#f6f4ed' }) {
  if (value === undefined) return { ...fallback };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['4/5', '3/4', '1/1'].includes(value.ratio)
    || !Number.isInteger(value.gutter) || value.gutter < 8 || value.gutter > 32
    || typeof value.bg !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.bg)) {
    throw validationError('画布设置无效：请选择支持的比例、8–32 px 间距和十六进制背景色');
  }
  return { ratio: value.ratio, gutter: value.gutter, bg: value.bg.toLowerCase() };
}

export function validateCharacterInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationError('角色数据无效');
  const fields = {};
  for (const [key, max] of [['name', 120], ['summary', 500], ['look', 2000], ['style', 1000]]) {
    const source = key === 'look' && input.look === undefined ? input.description : input[key];
    if (source === undefined) {
      if (!partial && key === 'name') throw validationError('角色名称不能为空');
      continue;
    }
    if (typeof source !== 'string' || source.trim().length > max || (key === 'name' && !source.trim())) {
      throw validationError(key === 'name' ? '角色名称无效' : `角色${key}字段无效`);
    }
    fields[key] = source.trim();
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 30 || input.tags.some(tag => typeof tag !== 'string' || tag.trim().length > 50)) throw validationError('角色标签无效');
    fields.tags = [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))];
  }
  if (input.referenceAssetIds !== undefined) {
    if (!Array.isArray(input.referenceAssetIds) || input.referenceAssetIds.length > 10
      || input.referenceAssetIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      || new Set(input.referenceAssetIds).size !== input.referenceAssetIds.length) throw validationError('角色参考资源列表无效');
    fields.referenceAssetIds = [...input.referenceAssetIds];
  }
  if (input.archivedAt !== undefined) {
    if (input.archivedAt !== null && !Number.isSafeInteger(input.archivedAt)) throw validationError('角色归档时间无效');
    fields.archivedAt = input.archivedAt;
  }
  return fields;
}
