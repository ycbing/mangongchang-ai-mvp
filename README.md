# 漫工厂 AI v0.1

本地单创作者漫画制作工具，默认无需账号或外部密钥即可从角色、分镜、逐格绘图一路做到长图导出。可选配置 OpenAI 兼容服务生成真实分镜与图片。数据使用 SQLite 与本地图片文件保存，服务器重启后可继续读取作品和任务。

## 启动

需要 Node.js 22 或更新版本（使用内置 SQLite）。在工程目录运行：

```sh
node server.mjs
```

打开 `http://localhost:4173`。首次启动会在 `data/mangongchang.sqlite` 建立数据库；旧版本的 `data/state.json` 会自动导入。图片保存在 `data/assets/`。`data/` 已加入忽略列表，请自行定期备份。

## 模型配置

复制 `.env.example` 为 `.env`，填写服务商参数后重启。密钥只由服务端读取，不会写入数据库或发送给浏览器。

- 分镜：OpenAI 兼容 `POST {LLM_BASE_URL}/chat/completions`，需支持 JSON object 响应。
- 绘图：OpenAI 兼容 `POST {IMAGE_BASE_URL}/images/generations`，接受 PNG/JPEG/WebP base64 或 HTTPS 图片链接。
- 缺少任一必要配置时，对应能力自动使用内置演示模式。

不同供应商对尺寸参数、JSON 响应和参考图的支持不同；当前参考图用于角色库预览，生成提示仍以文字锚点为主。当前没有可用于在线验证的供应商密钥。

## 可选单账号访问保护

默认保持本机免登录。若准备在受控网络环境启用一个共享访问密码，在 `.env` 设置 `AUTH_PASSWORD`（建议至少 16 位随机值），然后重启。登录使用 HttpOnly、SameSite Strict 会话 Cookie，API 写操作校验来源，服务端保存会话摘要并在过期后清理。部署到公网仍需 HTTPS、反向代理限流、备份和访问控制；本工程不提供注册、多用户或云端同步。

## 已实现能力

- 角色档案：搜索、锚点与风格、标签、参考图上传和预览、归档。
- 作品：新建（1–20 格）、搜索、过滤、复制、归档、回收站恢复和永久删除。
- AI 流程：分镜 JSON 校验与一次修复、单格重绘版本、批量绘图、失败重试接口、取消和持久任务记录。
- 编辑器：自动保存状态、冲突提示、本地草稿、格序拖放与快捷键、撤销/重做、画格比例/间距/背景、cover/contain/stretch、焦点位置、版本对比。
- 数据与导出：SQLite 状态与任务、最多 50 个状态历史快照、自动恢复未完成任务、JSON 作品备份导入/导出；PNG 长图支持宽度与最大高度设置，超过高度后按画格边界切片并提供逐张下载。
- 任务：本机单 owner 并发最多 2 个绘图任务，排队上限 20；幂等键、取消、重试、限流和生成文件校验。

JSON 备份包含作品和角色结构数据；图片二进制仍在本机 `data/assets/`，跨机器迁移时需一并复制该目录。

## API

前缀 `/api/v1`。包括 `health`、`config`、`auth`、`state`、`works`、`characters`、`assets/reference`、`jobs` 和图片资源路由。写入状态支持 revision 冲突检测；资源查询按本地固定 owner 限定。错误响应统一包含 `error.code`、`error.message` 和 `requestId`。

## 当前边界

这是本地开发版，不是多租户生产服务。账号模式只提供一个共享密码；数据库为 SQLite，队列 worker 在同一 Node 进程中运行，适合单机使用。产品文档里的 PostgreSQL/S3、Redis/BullMQ、多人协作、云端同步、公开发布仍需部署环境与基础设施；不能仅通过本地代码推送就视为已经部署。Canvas 文字渲染依赖当前浏览器字体，切片在浏览器本地生成。
