export function pendingDraftPresentation({ storageAvailable, hasRemote }) {
  return {
    storageNotice: storageAvailable
      ? '草稿已存入此浏览器。'
      : '浏览器缓存不可用，草稿目前只在当前页面内存中；刷新或关闭页面会丢失。',
    recoveryNotice: hasRemote
      ? '为避免覆盖其他修改，自动保存已暂停。现在可以选择使用服务器版本，或明确覆盖服务器版本。'
      : '为避免覆盖其他修改，自动保存已暂停。服务器版本暂不可用；可重新检查，或继续编辑。',
    keepLabel: storageAvailable ? '继续保留草稿' : '继续编辑（离开页面会丢失）',
  };
}

export function pendingDraftUnavailableMessage(storageAvailable) {
  return storageAvailable
    ? '服务器暂不可用；草稿已保存在浏览器'
    : '服务器暂不可用；草稿仅保留在当前页面，关闭可能丢失';
}
