# 漫工厂 AI v0.1

面向单创作者的漫画制作工具，可从角色、分镜、逐格绘图一路完成长图导出。默认使用本机 SQLite 和 mock AI，不需要账号或外部服务；部署时可配置 PostgreSQL。图片资源默认保存在本地目录，也可配置 S3 兼容对象存储。

## 本地启动

需要 Node.js 22 或更新版本。

```sh
npm ci
npm start
```

打开 `http://localhost:4173`。默认数据库为 `data/mangongchang.sqlite`，图片位于 `data/assets/`。首次启动会建立数据库；旧版 `data/state.json` 会自动导入。`data/` 已加入忽略列表，请自行定期备份。

运行内置回归检查：`npm test`。当前覆盖生产鉴权与 CSRF、画布/角色输入校验，以及 SQLite、备份清理和队列容量有关的并发/安全边界。可选的 PostgreSQL 多进程角色 revision 竞态测试需要设置 `PG_RACE_TEST_URL`；该 URL 必须连接到可创建数据库的 PostgreSQL 测试实例，测试会新建并删除一个随机命名的临时数据库，**不得指向生产实例**：

```sh
PG_RACE_TEST_URL=postgresql://TEST_ADMIN:PASSWORD@HOST:5432/postgres npm test
```

## PostgreSQL 部署

配置 PostgreSQL 连接串并设置至少 16 个字符的单账号访问密码。生产模式必须连接 PostgreSQL；缺少连接串、连接串格式错误或误设为 SQLite 时应用会拒绝启动：

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
AUTH_PASSWORD=替换为高强度随机密码
LOCAL_STORAGE_DIR=/持久化磁盘/mangongchang-assets
```

`DATABASE_URL` 非空时应用启动前会检查 PostgreSQL 连接并应用版本化迁移（`migrations/`）。迁移文件按三位或更多数字前缀排序，例如 `002_add_export_metadata.sql`；已经应用的迁移不要修改，新增变更请添加更高版本文件。应用启动和 `npm run db:migrate` 共用 PostgreSQL advisory lock，多个进程并发启动时会串行检查并应用迁移。迁移 SQL 会记录 SHA-256 校验值，后续启动会拒绝已应用文件被静默修改。连接池默认为 10，可用 `PG_POOL_MAX` 调整。作品快照写入事务会同步维护关系投影；作品、角色与画格按 ID 增量 upsert/删除，只有投影字段变化时才更新现有行；改动单个作品不会清空重建整个 owner 的投影，画格换序会在事务内避开唯一序号冲突。容器部署可设置 `HOST=0.0.0.0` 并放在 HTTPS 反向代理后；本机默认仅监听回环地址。未设置 `DATABASE_URL` 时仅在开发/测试模式使用 SQLite；生产模式会拒绝启动。若设置 `REDIS_URL`，任务会通过 BullMQ 投递到 Redis；数据库中的任务记录是恢复与轮询依据，应用会定时重新投递仍处于排队状态的任务。

关键整数运行参数会在启动时严格校验，非法值不会静默绕过限制：`PORT` 范围为 1–65535；`MAX_REQUEST_MB` 为 1–200；`MAX_IMAGE_UPLOAD_MB` 为 1–100；`AUTH_SESSION_DAYS` 为 1–30；`JOB_CONCURRENCY` 为 1–8；`PG_POOL_MAX` 为 1–100。未设置时使用 `.env.example` 中的默认值。PNG/JPEG/WebP 资源均在写入前解码校验，最大 24 MP 且不接受动画帧；图片文件大小仍受 `MAX_IMAGE_UPLOAD_MB` 限制。

将现有 SQLite 数据导入一个已创建、尚无作品数据的 PostgreSQL 数据库：

```sh
npm run db:migrate
npm run db:import-sqlite
```

导入脚本会先检查目标库所有业务表为空，避免覆盖；逐张验证源图片校验和后，在事务中迁入作品快照、角色、画格、版本历史、任务、会话和资源元数据，并把图片迁入当前配置的本地或 S3 存储。数据库事务失败时会清理本次新上传的对象。导入前请停掉应用并备份 SQLite 文件及图片目录。也可以通过 `SOURCE_DATABASE_PATH`、`SOURCE_ASSET_DIR` 指定来源路径。建议迁入后先在副本环境核对作品和图片，再切换正式服务。

**当前部署边界：** PostgreSQL 可用于应用状态、作品/角色投影、资源元数据、会话和任务记录；图片可存本机持久化目录或 S3 兼容存储。SQLite 本地模式由单进程处理任务；Compose 部署将 Web 与 BullMQ worker 分开。Docker/Redis 中断恢复和 S3 实例尚未在本机实测，上线前应完成相应联调、HTTPS 反向代理配置及数据库备份恢复演练。

### PostgreSQL 备份与恢复

先在 `.env` 配置 `DATABASE_URL` 和 `LOCAL_STORAGE_DIR`，并确保安装了 PostgreSQL 客户端工具（`pg_dump`）。运行 `npm run backup:postgres` 会创建 `data/backups/mangongchang-<时间>/`，其中包含 PostgreSQL custom-format 数据库转储、本地图片压缩包和记录各文件 SHA-256/大小的 `manifest.json`；备份目录权限为仅当前用户可读写。可通过 `BACKUP_DIR` 指定另一个备份目录。为确保数据库和图片处于同一时点，建议先停止应用写入，再备份；备份应复制到独立、加密且定期演练恢复的存储位置。命令会拒绝在配置了 `S3_BUCKET` 时执行，以免产生“数据库已备份但图片对象未备份”的不完整副本；S3 图片须另行启用对象版本控制/复制或执行供应商侧备份。

保留清理默认预览：`npm run backup:prune` 只识别含有效清单的产品备份目录，删除前会核对待清理文件的大小和 SHA-256。默认保留最新 14 个，并只考虑超过 90 天的更旧备份；其他文件夹、符号链接、缺失、不匹配或校验失败的备份会跳过。确认逐项清单后执行 `npm run backup:prune -- --apply`。可用 `--keep=20` 和 `--retention-days=180` 调整数量与天数。清理前应确认异地备份可用；本工具不代替异地备份和恢复演练。

Docker Compose 可选启用每日备份服务：`docker compose --profile backup up -d --build backup`。默认立即执行一次，此后每日运行；失败后 5 分钟重试，且只有新备份成功后才会清理过期备份。`BACKUP_INTERVAL_SECONDS`、`BACKUP_RETRY_SECONDS`、`BACKUP_KEEP`、`BACKUP_RETENTION_DAYS` 可调度和配置保留策略。备份放在独立的 `backup_data` 持久卷；该卷仍位于当前 Docker 主机，建议另行加密并复制到异地。自动任务不会停应用；数据库转储先于图片归档，图片上传按“先写对象、再登记数据库”处理。执行 `assets:gc` 或做严格的同一时点数据库/图片快照前，仍应暂停应用写入。配置 `S3_BUCKET` 时备份容器会跳过数据库备份，不会清理现有备份；请改用 S3 对象复制/版本控制及供应商侧数据库备份。

恢复前先停止应用，并确认目标 PostgreSQL 数据库就是准备覆盖的库。通过 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER` 和权限为 `0600` 的 `PGPASSFILE`（或 PostgreSQL service file）设置连接参数，然后运行 `pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$PGDATABASE" <备份目录>/database.dump` 恢复数据库，再将 `assets.tar.gz` 解压到配置的 `LOCAL_STORAGE_DIR`。恢复到空库后启动应用会自动应用缺失迁移；生产恢复应先在隔离环境演练，并按 `manifest.json` 核对文件 SHA-256。

可将通过清单校验的本地备份目录封装成 AES-256-GCM 认证加密文件后再复制到异地。先在备份目录之外生成并妥善保管 32 字节密钥（密钥不要与加密备份放在同一位置）：`openssl rand -out /secure/location/mangongchang-backup.key 32`，并将权限设为 `0600`。设置 `BACKUP_KEY_FILE=/secure/location/mangongchang-backup.key` 后运行 `npm run backup:seal -- <备份目录> <异地暂存路径>/mangongchang.mgbak`；仅复制该加密文件到异地存储。恢复时把密钥和文件取回隔离机器，运行 `npm run backup:unseal -- <加密文件> <恢复目录>/mangongchang.tar.gz`，认证成功后再解包并按前文步骤恢复数据库和图片。错误密钥、文件损坏或已存在的输出文件都会拒绝发布；工具不覆盖目标文件。密钥需单独备份，否则加密副本无法恢复。

## 模型配置

复制 `.env.example` 为 `.env`，填写模型服务参数后重启。密钥仅由服务端读取。

- 分镜：OpenAI 兼容 `POST {LLM_BASE_URL}/chat/completions`，需支持 JSON object 响应。
- 绘图：OpenAI 兼容 `POST {IMAGE_BASE_URL}/images/generations`，接受 PNG/JPEG/WebP base64 或 HTTPS 图片链接。
- 未配置完整参数时，对应能力使用内置 mock 模式。
- 模型 JSON 和生成图片均按配置上限流式读取；缺少 `Content-Length` 的响应也会在超过上限时中止。
- 绘图模型返回的图片链接必须为 HTTPS；服务端会拒绝私有、保留和本地 IP，连接固定到已校验的 DNS 地址，并对每次重定向重新执行校验，降低 SSRF 和 DNS 重绑定风险。

不同供应商对尺寸参数、JSON 响应和参考图的支持不同；当前参考图用于角色库预览，通用绘图端点仍以文字锚点为主。

## 已实现能力

- 角色档案：搜索、锚点与风格、标签、参考图上传和预览、归档。
- 作品：新建（1–20 格）、搜索、过滤、复制、归档、回收站恢复和永久删除。
- AI 流程：分镜 JSON 校验与一次修复、单格重绘版本、批量绘图、失败重试、取消和持久任务记录。
- 编辑器：自动保存；保存冲突或断网时将草稿保留在浏览器并暂停自动覆盖，需明确选择载入服务器版或覆盖；格序拖放与快捷键、撤销/重做、画格比例/间距/背景、图片适配和焦点位置、版本对比。
- 数据与导出：SQLite 开发存储或 PostgreSQL 部署存储、最多 50 个状态历史快照、JSON 作品备份导入/导出。导入会先校验版本、记录结构、ID、画布设置、资源地址和作品角色引用，整份校验通过后才合并；同 ID 记录覆盖前会提示。JSON 不包含图片二进制，跨环境迁移时需单独保留图片目录；PNG 长图由后台 ExportService/worker 按固定作品快照合成、切片并保存到资源层，任务支持进度、取消和重试，可从导出对话框查看历史并再次下载。
- 长图只接受 4:5、3:4、1:1 三种画幅；服务端先计算总像素预算（最多 32 MP），并限制 PNG 总大小 100 MB，超限在继续渲染/存储前终止任务。

## 可选单账号访问保护

设置 `AUTH_PASSWORD` 后启用一个共享访问密码。会话使用 HttpOnly、SameSite Strict Cookie，写操作校验请求来源。公网部署必须使用 HTTPS 和强密码。当前不提供注册、多用户、云端同步或多人协作。

静态服务只开放 `index.html`、`app.js`、共用漫画 SVG 组件 `comic-art.js` 和草稿提示组件 `draft-presentation.js`；`.env`、数据库、其他源码、迁移和依赖目录不会通过页面路由发布。页面使用禁止内联脚本的内容安全策略与 `no-cache` 重新验证；API 与页面统一返回 `nosniff`、禁止 iframe、同源 Referrer 和限制摄像头/麦克风/地理位置的 Permissions Policy。生产鉴权集成测试会校验这些响应头。

## API

前缀 `/api/v1`，包括 `health`、`config`、`auth`、`state`、`works`、`characters`、`assets/reference`、`assets/export-slices`、`jobs` 和图片资源路由。全量状态写入会校验作品/角色 ID 唯一性、1–20 格数量、角色引用、画布配置、画格版本、图片地址和文字布局，再执行 revision 冲突检测，避免结构损坏的数据覆盖有效快照；创建作品时也校验画格数、角色归属和画布参数（比例 `4/5`、`3/4`、`1/1`，间距 8–32 px，背景为 `#RRGGBB`），更新作品使用相同画布约束。角色 API 只接受公开业务字段，参考资源须属于当前 owner。作品 `GET/POST /works/:id/exports` 提供导出历史；POST 默认创建后台导出任务，切片与任务完成记录在事务中保存，并支持 `Idempotency-Key`。错误响应包含 `error.code`、`error.message` 和 `requestId`。`GET /healthz` 仅返回最小就绪状态供容器探针使用；详细 `GET /api/v1/health` 检查数据库、任务队列、资源存储和模型配置，并受账号鉴权保护。

## Docker Compose 部署

复制 `.env.example` 为 `.env`，然后分别运行三次 `openssl rand -hex 32`，将三个不同结果填入 `POSTGRES_PASSWORD`、`REDIS_PASSWORD` 和 `AUTH_PASSWORD`。十六进制密码有 256 位随机熵，也能避免数据库/Redis URL 中的特殊字符转义问题。启用账号鉴权后，登录和所有写请求都必须带同源 Origin 或 Referer；无来源头、跨源来源都会被拒绝。启动命令：

```sh
docker compose up --build -d
```

Compose 会先等待 PostgreSQL 和 Redis 健康，再启动 Web 服务并自动执行数据库迁移；独立 worker 在 Web 健康后启动，消费 BullMQ 任务。容器使用无需登录且只返回最小状态的 `/healthz` 探针，依赖不可用时返回 HTTP 503；登录后的 `/api/v1/health` 提供数据库、队列和图片存储检查明细；本地存储检查目录读写权限，S3 检查 bucket 可达性。可用 `docker compose ps` 查看 Web、worker 和依赖状态。PostgreSQL、Redis 队列和本地图片分别保存在 Docker 持久卷中。访问 `http://localhost:4173`。如需对象存储，在 `.env` 配置 `S3_BUCKET`、区域、端点及访问凭证；Web 与 worker 都会检查 bucket，上传、读取和迁移都会走 S3 适配层。公网使用时应在前方配置 HTTPS 反向代理，并按部署环境配置备份。

### S3 兼容图片存储

设置 `S3_BUCKET` 可将角色参考图和生成图片写入 S3；留空时应用继续使用 `LOCAL_STORAGE_DIR`。可配置 `S3_ENDPOINT`（MinIO 等兼容服务）、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 和 `S3_FORCE_PATH_STYLE`。若运行环境支持 IAM/默认凭证链，可省略访问密钥；提供自定义端点时，非本机地址必须使用 HTTPS。应用启动会检查 bucket 访问权限，健康接口会返回实际图片存储类型。上传对象会保存 SHA-256 元数据，下载时对带校验元数据的对象重新计算并核验；元数据格式无效或校验不匹配会使读取失败。历史上未带校验元数据的对象仍可读取。数据库迁移脚本会按当前存储配置迁移并校验图片对象。

资源清理默认只做预览：`npm run assets:gc` 会列出当前作品/角色没有引用且超过 30 天的资源数量、总大小，以及每项资源的存储键、资源 ID、字节数和保存天数，不会删除文件。确认清单并备份后，再运行 `npm run assets:gc -- --apply` 执行删除；执行时也会逐项记录已删除资源。可用 `--grace-days=60` 延长保留期（范围 7–365 天）。清理依据是当前数据库快照；JSON 备份不包含图片二进制，若要日后导入旧备份，请先保留对应图片资源。


### 任务队列

本地默认使用数据库持久化记录加进程内 worker，不需要 Redis。设置 `REDIS_URL` 后启用 BullMQ；可通过 `SERVICE_ROLE=web` 和 `SERVICE_ROLE=worker` 将 Web 与 worker 分开，Docker Compose 已分别配置两个服务。Web 定时投递数据库中的 queued 任务，worker 使用数据库条件更新领取任务，避免同一任务被重复执行；worker 每 15 秒更新数据库心跳，恢复器按最近心跳判断 5 分钟失联租约，旧的无心跳 running 任务回退到 started_at 兼容恢复。Web 在读取/修改作品状态前刷新快照，写入使用 revision 条件提交；worker 从数据库最新快照合并画格结果并在冲突时重试。取消状态由 worker 每秒轮询数据库，因此不依赖进程内共享内存。worker 负责分镜/绘图 provider 与 Sharp 长图合成；导出固定作品快照，完成后将 PNG 切片和成功任务记录写入数据库。批量绘图拒绝重复画格，并在数据库事务中一起检查 20 项容量上限和写入，避免超额或部分入队。Docker Compose 默认带持久化 Redis，并设置 `maxmemory-policy=noeviction`。真实 Redis 中断恢复仍需环境联调。

## 持续集成

GitHub Actions 在每次推送到 `main` 和拉取请求时运行 Node 测试，并提供真实 PostgreSQL、Redis 服务覆盖数据库并发竞态和 BullMQ 跨进程投递；独立 Compose 冒烟任务构建生产镜像，检查鉴权、PostgreSQL/Redis 健康状态及 Web 到 worker 的 mock 分镜任务闭环。该工作流成功记录需以仓库 Actions 实际运行结果为准。
