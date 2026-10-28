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

`DATABASE_URL` 非空时应用启动前会检查 PostgreSQL 连接并应用版本化迁移（`migrations/`）。迁移文件按三位或更多数字前缀排序，例如 `002_add_export_metadata.sql`；已经应用的迁移不要修改，新增变更请添加更高版本文件。应用启动和 `npm run db:migrate` 共用 PostgreSQL advisory lock，多个进程并发启动时会串行检查并应用迁移。迁移 SQL 会记录 SHA-256 校验值，后续启动会拒绝已应用文件被静默修改。连接池默认为 10，可用 `PG_POOL_MAX` 调整。容器部署可设置 `HOST=0.0.0.0` 并放在 HTTPS 反向代理后；本机默认仅监听回环地址。没有 `DATABASE_URL` 时继续使用 SQLite。若设置 `REDIS_URL`，任务会通过 BullMQ 投递到 Redis；数据库中的任务记录是恢复与轮询依据，应用会定时重新投递仍处于排队状态的任务。

将现有 SQLite 数据导入一个已创建、尚无作品数据的 PostgreSQL 数据库：

```sh
npm run db:migrate
npm run db:import-sqlite
```

导入脚本会先检查目标库所有业务表为空，避免覆盖；逐张验证源图片校验和后，在事务中迁入作品快照、角色、画格、版本历史、任务、会话和资源元数据，并把图片迁入当前配置的本地或 S3 存储。数据库事务失败时会清理本次新上传的对象。导入前请停掉应用并备份 SQLite 文件及图片目录。也可以通过 `SOURCE_DATABASE_PATH`、`SOURCE_ASSET_DIR` 指定来源路径。建议迁入后先在副本环境核对作品和图片，再切换正式服务。

**当前部署边界：** PostgreSQL 已用于应用状态、作品/角色投影、资源元数据、会话和任务记录；图片可存本机持久化目录或 S3 兼容存储。任务仍在同一 Node 进程执行，因此目前适合单实例部署。多实例部署仍需 Redis/BullMQ 独立 worker。上线时需使用持久化存储、HTTPS 反向代理、数据库备份与恢复演练。

### PostgreSQL 备份与恢复

先在 `.env` 配置 `DATABASE_URL` 和 `LOCAL_STORAGE_DIR`，并确保安装了 PostgreSQL 客户端工具（`pg_dump`）。运行 `npm run backup:postgres` 会创建 `data/backups/mangongchang-<时间>/`，其中包含 PostgreSQL custom-format 数据库转储、本地图片压缩包和记录各文件 SHA-256/大小的 `manifest.json`；备份目录权限为仅当前用户可读写。可通过 `BACKUP_DIR` 指定另一个备份目录。为确保数据库和图片处于同一时点，建议先停止应用写入，再备份；备份应复制到独立、加密且定期演练恢复的存储位置。命令会拒绝在配置了 `S3_BUCKET` 时执行，以免产生“数据库已备份但图片对象未备份”的不完整副本；S3 图片须另行启用对象版本控制/复制或执行供应商侧备份。

保留清理默认预览：`npm run backup:prune` 只识别含有效清单的产品备份目录，删除前会核对待清理文件的大小和 SHA-256。默认保留最新 14 个，并只考虑超过 90 天的更旧备份；其他文件夹、符号链接、缺失、不匹配或校验失败的备份会跳过。确认逐项清单后执行 `npm run backup:prune -- --apply`。可用 `--keep=20` 和 `--retention-days=180` 调整数量与天数。清理前应确认异地备份可用；本工具不代替异地备份和恢复演练。

Docker Compose 可选启用每日备份服务：`docker compose --profile backup up -d --build backup`。默认立即执行一次，此后每日运行；失败后 5 分钟重试，且只有新备份成功后才会清理过期备份。`BACKUP_INTERVAL_SECONDS`、`BACKUP_RETRY_SECONDS`、`BACKUP_KEEP`、`BACKUP_RETENTION_DAYS` 可调度和配置保留策略。备份放在独立的 `backup_data` 持久卷；该卷仍位于当前 Docker 主机，建议另行加密并复制到异地。自动任务不会停应用；数据库转储先于图片归档，图片上传按“先写对象、再登记数据库”处理。执行 `assets:gc` 或做严格的同一时点数据库/图片快照前，仍应暂停应用写入。配置 `S3_BUCKET` 时备份容器会跳过数据库备份，不会清理现有备份；请改用 S3 对象复制/版本控制及供应商侧数据库备份。

恢复前先停止应用，并确认目标 PostgreSQL 数据库就是准备覆盖的库。通过 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER` 和权限为 `0600` 的 `PGPASSFILE`（或 PostgreSQL service file）设置连接参数，然后运行 `pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$PGDATABASE" <备份目录>/database.dump` 恢复数据库，再将 `assets.tar.gz` 解压到配置的 `LOCAL_STORAGE_DIR`。恢复到空库后启动应用会自动应用缺失迁移；生产恢复应先在隔离环境演练，并按 `manifest.json` 核对文件 SHA-256。

## 模型配置

复制 `.env.example` 为 `.env`，填写模型服务参数后重启。密钥仅由服务端读取。

- 分镜：OpenAI 兼容 `POST {LLM_BASE_URL}/chat/completions`，需支持 JSON object 响应。
- 绘图：OpenAI 兼容 `POST {IMAGE_BASE_URL}/images/generations`，接受 PNG/JPEG/WebP base64 或 HTTPS 图片链接。
- 未配置完整参数时，对应能力使用内置 mock 模式。
- 模型 JSON 和生成图片均按配置上限流式读取；缺少 `Content-Length` 的响应也会在超过上限时中止。

不同供应商对尺寸参数、JSON 响应和参考图的支持不同；当前参考图用于角色库预览，通用绘图端点仍以文字锚点为主。

## 已实现能力

- 角色档案：搜索、锚点与风格、标签、参考图上传和预览、归档。
- 作品：新建（1–20 格）、搜索、过滤、复制、归档、回收站恢复和永久删除。
- AI 流程：分镜 JSON 校验与一次修复、单格重绘版本、批量绘图、失败重试、取消和持久任务记录。
- 编辑器：自动保存；保存冲突或断网时将草稿保留在浏览器并暂停自动覆盖，需明确选择载入服务器版或覆盖；格序拖放与快捷键、撤销/重做、画格比例/间距/背景、图片适配和焦点位置、版本对比。
- 数据与导出：SQLite 开发存储或 PostgreSQL 部署存储、最多 50 个状态历史快照、JSON 作品备份导入/导出。导入会先校验版本、记录结构、ID、画布设置、资源地址和作品角色引用，整份校验通过后才合并；同 ID 记录覆盖前会提示。JSON 不包含图片二进制，跨环境迁移时需单独保留图片目录；PNG 长图按格边界切片并逐张下载。

## 可选单账号访问保护

设置 `AUTH_PASSWORD` 后启用一个共享访问密码。会话使用 HttpOnly、SameSite Strict Cookie，写操作校验请求来源。公网部署必须使用 HTTPS 和强密码。当前不提供注册、多用户、云端同步或多人协作。

静态服务只开放 `index.html` 和 `app.js`；`.env`、数据库、源码、迁移和依赖目录不会通过页面路由发布。内容安全策略禁止内联脚本。

## API

前缀 `/api/v1`，包括 `health`、`config`、`auth`、`state`、`works`、`characters`、`assets/reference`、`jobs` 和图片资源路由。状态写入支持 revision 冲突检测；错误响应包含 `error.code`、`error.message` 和 `requestId`。

## Docker Compose 部署

复制 `.env.example` 为 `.env`，然后为 `POSTGRES_PASSWORD`、`REDIS_PASSWORD` 和 `AUTH_PASSWORD` 分别设置高强度随机值（数据库和 Redis 密码建议使用字母数字，确保连接串安全）。启动命令：

```sh
docker compose up --build -d
```

Compose 会先等待 PostgreSQL 和 Redis 健康，再启动应用并自动执行数据库迁移；`/api/v1/health` 会检查数据库与 Redis 的连接，依赖不可用时返回 HTTP 503。应用容器用该接口做健康检查，可用 `docker compose ps` 查看服务状态。PostgreSQL、Redis 队列和本地图片分别保存在 Docker 持久卷中。访问 `http://localhost:4173`。如需对象存储，在 `.env` 配置 `S3_BUCKET`、区域、端点及访问凭证；应用启动会检查 bucket，上传、读取和迁移都会走 S3 适配层。公网使用时应在前方配置 HTTPS 反向代理，并按部署环境配置备份。

### S3 兼容图片存储

设置 `S3_BUCKET` 可将角色参考图和生成图片写入 S3；留空时应用继续使用 `LOCAL_STORAGE_DIR`。可配置 `S3_ENDPOINT`（MinIO 等兼容服务）、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 和 `S3_FORCE_PATH_STYLE`。若运行环境支持 IAM/默认凭证链，可省略访问密钥；提供自定义端点时，非本机地址必须使用 HTTPS。应用启动会检查 bucket 访问权限，健康接口会返回实际图片存储类型。数据库迁移脚本会按当前存储配置迁移并校验图片对象。

资源清理默认只做预览：`npm run assets:gc` 会列出当前作品/角色没有引用且超过 30 天的资源数量、总大小，以及每项资源的存储键、资源 ID、字节数和保存天数，不会删除文件。确认清单并备份后，再运行 `npm run assets:gc -- --apply` 执行删除；执行时也会逐项记录已删除资源。可用 `--grace-days=60` 延长保留期（范围 7–365 天）。清理依据是当前数据库快照；JSON 备份不包含图片二进制，若要日后导入旧备份，请先保留对应图片资源。


### 任务队列

本地默认使用数据库持久化记录加进程内 worker，不需要 Redis。设置 `REDIS_URL` 后启用 BullMQ，应用会把数据库中的排队任务按任务 ID 投递到 Redis；worker 使用数据库条件更新领取任务，避免同一任务被重复执行。Redis 连接中断时，数据库里的 queued 任务会由后台定时器重新投递。Docker Compose 默认带持久化 Redis，并设置 `maxmemory-policy=noeviction`。当前 worker 仍随应用进程启动，正式横向扩容前还需完成多实例状态同步和独立 worker 部署。
