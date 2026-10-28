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

export function validateStateSnapshot(input) {
  const fail = message => { throw validationError(message); };
  const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
  const safeImage = value => typeof value === 'string' && value.length <= 20_000_000
    && (!value || /^\/assets\/[A-Za-z0-9-]+\.(?:png|jpg|webp)$/i.test(value)
      || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value));
  const timestamp = (value, label) => {
    if (value !== undefined && value !== null && !Number.isSafeInteger(value)) fail(`${label}时间无效`);
  };

  if (!isRecord(input) || !Array.isArray(input.works) || !Array.isArray(input.characters)) fail('作品或角色数据结构无效');
  if (input.works.length > 2000 || input.characters.length > 2000) fail('作品或角色数量超过上限');
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0)) fail('数据版本无效');
  if (input.activeId !== undefined && input.activeId !== null && !validId(input.activeId)) fail('当前作品 ID 无效');

  const characterIds = new Set();
  for (const character of input.characters) {
    if (!isRecord(character) || !validId(character.id) || characterIds.has(character.id)
      || typeof character.name !== 'string' || !character.name.trim() || character.name.length > 2000) fail('角色记录无效：名称或 ID 不正确');
    characterIds.add(character.id);
    for (const key of ['summary', 'look', 'style']) {
      if (character[key] !== undefined && (typeof character[key] !== 'string' || character[key].length > 100_000)) fail(`角色${key}字段无效`);
    }
    if (character.tags !== undefined && (!Array.isArray(character.tags) || character.tags.length > 500
      || character.tags.some(tag => typeof tag !== 'string' || tag.length > 1000))) fail('角色标签无效');
    if (character.referenceAssetIds !== undefined && (!Array.isArray(character.referenceAssetIds) || character.referenceAssetIds.length > 1000
      || character.referenceAssetIds.some(id => !validId(id)))) fail('角色参考图列表无效');
    if (character.referenceUrl !== undefined && !safeImage(character.referenceUrl)) fail('角色参考图地址无效');
    timestamp(character.archivedAt, '角色归档');
    timestamp(character.deletedAt, '角色删除');
  }

  const workIds = new Set();
  for (const work of input.works) {
    if (!isRecord(work) || !validId(work.id) || workIds.has(work.id) || typeof work.title !== 'string'
      || !work.title.trim() || work.title.length > 2000
      || (work.premise !== undefined && (typeof work.premise !== 'string' || work.premise.length > 100_000))) fail('作品记录无效：标题、主题或 ID 不正确');
    workIds.add(work.id);
    if (work.characterId != null && (!validId(work.characterId) || !characterIds.has(work.characterId))) fail(`作品《${work.title}》引用的角色不存在`);
    if (work.characterSnapshot !== undefined && !isRecord(work.characterSnapshot)) fail(`作品《${work.title}》的角色快照无效`);
    if (!Array.isArray(work.panels) || work.panels.length < 1 || work.panels.length > 20) fail(`作品《${work.title}》必须包含 1–20 格`);
    if (work.settings !== undefined) {
      try { validateCanvasSettings(work.settings); }
      catch { fail(`作品《${work.title}》的画布设置无效`); }
    }
    if (work.status !== undefined && !['draft', 'storyboarding', 'generating', 'editing', 'exporting', 'ready', 'failed'].includes(work.status)) fail(`作品《${work.title}》的状态无效`);
    timestamp(work.archivedAt, '作品归档');
    timestamp(work.deletedAt, '作品删除');
    timestamp(work.updatedAt, '作品更新时间');
    timestamp(work.exportedAt, '作品导出');

    const panelIds = new Set();
    for (const panel of work.panels) {
      if (!isRecord(panel) || !validId(panel.id) || panelIds.has(panel.id)) fail(`作品《${work.title}》包含无效或重复的画格 ID`);
      panelIds.add(panel.id);
      for (const key of ['scene', 'action', 'camera', 'expression', 'dialogue', 'caption', 'sfx', 'imagePrompt', 'negativePrompt', 'tone']) {
        if (panel[key] !== undefined && (typeof panel[key] !== 'string' || panel[key].length > 100_000)) fail(`作品《${work.title}》的画格文本无效`);
      }
      if (panel.versions !== undefined && (!Array.isArray(panel.versions) || !panel.versions.length || panel.versions.length > 1000
        || panel.versions.some(version => !Number.isInteger(version) || version < 1) || new Set(panel.versions).size !== panel.versions.length)) fail(`作品《${work.title}》的版本列表无效`);
      if (panel.version !== undefined && (!Number.isInteger(panel.version) || panel.version < 1)) fail(`作品《${work.title}》的当前版本无效`);
      if (!(panel.versions || [1]).includes(panel.version || 1)) fail(`作品《${work.title}》的当前版本不在版本列表中`);
      if (panel.fit !== undefined && !['cover', 'contain', 'stretch'].includes(panel.fit)) fail(`作品《${work.title}》的图片适配方式无效`);
      if (panel.imageVersions !== undefined && (!Array.isArray(panel.imageVersions) || panel.imageVersions.length > 1000
        || panel.imageVersions.some(image => !isRecord(image) || !safeImage(image.url)))) fail(`作品《${work.title}》的画格图片版本无效`);
      if (panel.elements !== undefined && (!Array.isArray(panel.elements) || panel.elements.length > 100)) fail(`作品《${work.title}》的画格元素数量无效`);
      if (panel.focalPoint !== undefined && (!isRecord(panel.focalPoint)
        || !['x', 'y'].every(key => Number.isFinite(panel.focalPoint[key]) && panel.focalPoint[key] >= 0 && panel.focalPoint[key] <= 1))) fail(`作品《${work.title}》的画面焦点无效`);
      for (const key of ['dialogueLayout', 'captionLayout']) {
        if (panel[key] !== undefined && (!isRecord(panel[key])
          || !['x', 'y', 'w', 'h'].every(field => Number.isFinite(panel[key][field]) && panel[key][field] >= 0 && panel[key][field] <= 1))) fail(`作品《${work.title}》的文字布局无效`);
      }
    }
  }
  if (input.activeId != null && !workIds.has(input.activeId)) fail('当前作品不存在');
  return input;
}
