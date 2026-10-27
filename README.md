# 漫工厂 AI v0.1

面向单创作者的漫画制作工具，可从角色、分镜、逐格绘图一路完成长图导出。默认使用本机 SQLite 和 mock AI，不需要账号或外部服务；部署时可配置 PostgreSQL。图片资源默认保存在本地目录，也可配置 S3 兼容对象存储。

## 本地启动

需要 Node.js 22 或更新版本。

```sh
npm ci
npm start
```

打开 `http://localhost:4173`。默认数据库为 `data/mangongchang.sqlite`，图片位于 `data/assets/`。首次启动会建立数据库；旧版 `data/state.json` 会自动导入。`data/` 已加入忽略列表，请自行定期备份。

## PostgreSQL 部署

配置 PostgreSQL 连接串并设置单账号访问密码：

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
AUTH_PASSWORD=替换为高强度随机密码
LOCAL_STORAGE_DIR=/持久化磁盘/mangongchang-assets
```

`DATABASE_URL` 非空时应用启动前会检查 PostgreSQL 连接并应用版本化迁移（`migrations/`）。连接池默认为 10，可用 `PG_POOL_MAX` 调整。容器部署可设置 `HOST=0.0.0.0` 并放在 HTTPS 反向代理后；本机默认仅监听回环地址。没有 `DATABASE_URL` 时继续使用 SQLite。

将现有 SQLite 数据导入一个已创建、尚无作品数据的 PostgreSQL 数据库：

```sh
npm run db:migrate
npm run db:import-sqlite
```

导入脚本会先检查目标库所有业务表为空，避免覆盖；逐张验证源图片校验和后，在事务中迁入作品快照、角色、画格、版本历史、任务、会话和资源元数据，并把图片迁入当前配置的本地或 S3 存储。数据库事务失败时会清理本次新上传的对象。导入前请停掉应用并备份 SQLite 文件及图片目录。也可以通过 `SOURCE_DATABASE_PATH`、`SOURCE_ASSET_DIR` 指定来源路径。建议迁入后先在副本环境核对作品和图片，再切换正式服务。

**当前部署边界：** PostgreSQL 已用于应用状态、作品/角色投影、资源元数据、会话和任务记录；图片可存本机持久化目录或 S3 兼容存储。任务仍在同一 Node 进程执行，因此目前适合单实例部署。多实例部署仍需 Redis/BullMQ 独立 worker。上线时需使用持久化存储、HTTPS 反向代理、数据库备份与恢复演练。

## 模型配置

复制 `.env.example` 为 `.env`，填写模型服务参数后重启。密钥仅由服务端读取。

- 分镜：OpenAI 兼容 `POST {LLM_BASE_URL}/chat/completions`，需支持 JSON object 响应。
- 绘图：OpenAI 兼容 `POST {IMAGE_BASE_URL}/images/generations`，接受 PNG/JPEG/WebP base64 或 HTTPS 图片链接。
- 未配置完整参数时，对应能力使用内置 mock 模式。

不同供应商对尺寸参数、JSON 响应和参考图的支持不同；当前参考图用于角色库预览，通用绘图端点仍以文字锚点为主。

## 已实现能力

- 角色档案：搜索、锚点与风格、标签、参考图上传和预览、归档。
- 作品：新建（1–20 格）、搜索、过滤、复制、归档、回收站恢复和永久删除。
- AI 流程：分镜 JSON 校验与一次修复、单格重绘版本、批量绘图、失败重试、取消和持久任务记录。
- 编辑器：自动保存、冲突提示、格序拖放与快捷键、撤销/重做、画格比例/间距/背景、图片适配和焦点位置、版本对比。
- 数据与导出：SQLite 开发存储或 PostgreSQL 部署存储、最多 50 个状态历史快照、JSON 作品备份导入/导出；PNG 长图按格边界切片并逐张下载。

## 可选单账号访问保护

设置 `AUTH_PASSWORD` 后启用一个共享访问密码。会话使用 HttpOnly、SameSite Strict Cookie，写操作校验请求来源。公网部署必须使用 HTTPS 和强密码。当前不提供注册、多用户、云端同步或多人协作。

## API

前缀 `/api/v1`，包括 `health`、`config`、`auth`、`state`、`works`、`characters`、`assets/reference`、`jobs` 和图片资源路由。状态写入支持 revision 冲突检测；错误响应包含 `error.code`、`error.message` 和 `requestId`。

## Docker Compose 部署

复制 `.env.example` 为 `.env`，然后为 `POSTGRES_PASSWORD` 和 `AUTH_PASSWORD` 分别设置高强度随机值（数据库密码建议使用字母数字，确保连接串安全）。启动命令：

```sh
docker compose up --build -d
```

Compose 会先等待 PostgreSQL 健康，再启动应用并自动执行数据库迁移；数据库和本地图片分别保存在 Docker 持久卷中。访问 `http://localhost:4173`。如需对象存储，在 `.env` 配置 `S3_BUCKET`、区域、端点及访问凭证；应用启动会检查 bucket，上传、读取和迁移都会走 S3 适配层。公网使用时应在前方配置 HTTPS 反向代理，并按部署环境配置备份。

### S3 兼容图片存储

设置 `S3_BUCKET` 可将角色参考图和生成图片写入 S3；留空时应用继续使用 `LOCAL_STORAGE_DIR`。可配置 `S3_ENDPOINT`（MinIO 等兼容服务）、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 和 `S3_FORCE_PATH_STYLE`。若运行环境支持 IAM/默认凭证链，可省略访问密钥；提供自定义端点时，非本机地址必须使用 HTTPS。应用启动会检查 bucket 访问权限，健康接口会返回实际图片存储类型。数据库迁移脚本会按当前存储配置迁移并校验图片对象。
