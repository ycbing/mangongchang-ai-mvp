function panelStoryboard(panel) {
  return JSON.stringify({
    scene: panel.scene || '', action: panel.action || '', camera: panel.camera || '', expression: panel.expression || '',
    dialogue: panel.dialogue || '', caption: panel.caption || '', sfx: panel.sfx || '', imagePrompt: panel.imagePrompt || '',
    negativePrompt: panel.negativePrompt || '', tone: panel.tone || '',
  });
}

function panelLayout(panel, work) {
  return JSON.stringify({
    ratio: work.settings?.ratio || '4/5', fit: panel.fit || 'cover', focalPoint: panel.focalPoint || { x: 0.5, y: 0.5 },
    dialogueLayout: panel.dialogueLayout || null, captionLayout: panel.captionLayout || null, elements: panel.elements || [],
  });
}

export async function syncDatabaseProjection(tx, snapshot, ownerId) {
  const characters = Array.isArray(snapshot.characters) ? snapshot.characters : [];
  const works = Array.isArray(snapshot.works) ? snapshot.works : [];
  const workIds = new Set(works.map(work => work.id));
  const characterIds = new Set(characters.map(character => character.id));
  const oldWorks = await tx.prepare('SELECT id FROM works WHERE owner_id=?').all(ownerId);
  const oldCharacters = await tx.prepare('SELECT id FROM characters WHERE owner_id=?').all(ownerId);

  for (const row of oldWorks) {
    if (workIds.has(row.id)) continue;
    await tx.prepare('DELETE FROM panels WHERE work_id=?').run(row.id);
    await tx.prepare('DELETE FROM work_characters WHERE work_id=?').run(row.id);
    await tx.prepare('DELETE FROM works WHERE id=? AND owner_id=?').run(row.id, ownerId);
  }
  for (const row of oldCharacters) {
    if (!characterIds.has(row.id)) await tx.prepare('DELETE FROM characters WHERE id=? AND owner_id=?').run(row.id, ownerId);
  }

  const putCharacter = tx.prepare(`INSERT INTO characters(id,owner_id,name,summary,visual_profile_json,style_anchors_json,reference_asset_ids_json,tags_json,created_at,updated_at,archived_at,deleted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,summary=excluded.summary,visual_profile_json=excluded.visual_profile_json,
    style_anchors_json=excluded.style_anchors_json,reference_asset_ids_json=excluded.reference_asset_ids_json,tags_json=excluded.tags_json,
    updated_at=excluded.updated_at,archived_at=excluded.archived_at,deleted_at=excluded.deleted_at WHERE characters.owner_id=excluded.owner_id AND
    (characters.name IS DISTINCT FROM excluded.name OR characters.summary IS DISTINCT FROM excluded.summary OR characters.visual_profile_json IS DISTINCT FROM excluded.visual_profile_json OR
     characters.style_anchors_json IS DISTINCT FROM excluded.style_anchors_json OR characters.reference_asset_ids_json IS DISTINCT FROM excluded.reference_asset_ids_json OR
     characters.tags_json IS DISTINCT FROM excluded.tags_json OR characters.updated_at IS DISTINCT FROM excluded.updated_at OR
     characters.archived_at IS DISTINCT FROM excluded.archived_at OR characters.deleted_at IS DISTINCT FROM excluded.deleted_at)`);
  for (const character of characters) {
    await putCharacter.run(character.id, ownerId, String(character.name || ''), String(character.summary || ''),
      JSON.stringify(character.visualProfile || { look: character.look || '' }), JSON.stringify(character.styleAnchors || { style: character.style || '' }),
      JSON.stringify(character.referenceAssetIds || []), JSON.stringify(character.tags || []), character.createdAt || character.updatedAt || Date.now(),
      character.updatedAt || Date.now(), character.archivedAt || null, character.deletedAt || null);
  }

  const putWork = tx.prepare(`INSERT INTO works(id,owner_id,title,premise,status,settings_json,character_snapshot_json,created_at,updated_at,archived_at,deleted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,premise=excluded.premise,status=excluded.status,settings_json=excluded.settings_json,
    character_snapshot_json=excluded.character_snapshot_json,updated_at=excluded.updated_at,archived_at=excluded.archived_at,deleted_at=excluded.deleted_at
    WHERE works.owner_id=excluded.owner_id AND (works.title IS DISTINCT FROM excluded.title OR works.premise IS DISTINCT FROM excluded.premise OR
    works.status IS DISTINCT FROM excluded.status OR works.settings_json IS DISTINCT FROM excluded.settings_json OR
    works.character_snapshot_json IS DISTINCT FROM excluded.character_snapshot_json OR works.updated_at IS DISTINCT FROM excluded.updated_at OR
    works.archived_at IS DISTINCT FROM excluded.archived_at OR works.deleted_at IS DISTINCT FROM excluded.deleted_at)`);
  const putLink = tx.prepare(`INSERT INTO work_characters(work_id,character_id,snapshot_json) VALUES(?,?,?)
    ON CONFLICT(work_id,character_id) DO UPDATE SET snapshot_json=excluded.snapshot_json
    WHERE work_characters.snapshot_json IS DISTINCT FROM excluded.snapshot_json`);
  const putPanel = tx.prepare(`INSERT INTO panels(id,work_id,order_index,storyboard_json,layout_json,current_image_asset_id,generation_status,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(work_id,id) DO UPDATE SET order_index=excluded.order_index,storyboard_json=excluded.storyboard_json,
    layout_json=excluded.layout_json,current_image_asset_id=excluded.current_image_asset_id,generation_status=excluded.generation_status,updated_at=excluded.updated_at
    WHERE panels.order_index IS DISTINCT FROM excluded.order_index OR panels.storyboard_json IS DISTINCT FROM excluded.storyboard_json OR
    panels.layout_json IS DISTINCT FROM excluded.layout_json OR panels.current_image_asset_id IS DISTINCT FROM excluded.current_image_asset_id OR
    panels.generation_status IS DISTINCT FROM excluded.generation_status OR panels.updated_at IS DISTINCT FROM excluded.updated_at`);

  for (const work of works) {
    const now = work.updatedAt || Date.now();
    await putWork.run(work.id, ownerId, String(work.title || ''), String(work.premise || ''), work.status || 'editing', JSON.stringify(work.settings || {}),
      JSON.stringify(work.characterSnapshot || null), work.createdAt || now, now, work.archivedAt || null, work.deletedAt || null);
    if (work.characterId) {
      await tx.prepare('DELETE FROM work_characters WHERE work_id=? AND character_id<>?').run(work.id, work.characterId);
      await putLink.run(work.id, work.characterId, JSON.stringify(work.characterSnapshot || {}));
    } else await tx.prepare('DELETE FROM work_characters WHERE work_id=?').run(work.id);

    const panels = Array.isArray(work.panels) ? work.panels : [];
    const existing = await tx.prepare('SELECT id,order_index FROM panels WHERE work_id=? ORDER BY order_index').all(work.id);
    const sameOrder = existing.length === panels.length && existing.every((panel, index) => panel.id === panels[index].id && Number(panel.order_index) === index);
    if (!sameOrder && existing.length) await tx.prepare('UPDATE panels SET order_index=-order_index-1 WHERE work_id=?').run(work.id);

    for (let index = 0; index < panels.length; index++) {
      const panel = panels[index], current = panel.imageVersions?.find(version => version.version === panel.version);
      await putPanel.run(panel.id, work.id, index, panelStoryboard(panel), panelLayout(panel, work), current?.assetId || null, panel.generationStatus || 'draft', now);
    }
    const retainedIds = new Set(panels.map(panel => panel.id));
    for (const panel of existing) if (!retainedIds.has(panel.id)) await tx.prepare('DELETE FROM panels WHERE work_id=? AND id=?').run(work.id, panel.id);
  }
}
