# 漫工厂 AI v0.1 可运行 MVP

这是一个零依赖的本地 Web MVP，包含角色库、作品管理、AI 分镜、逐格绘图与版本切换、漫画编辑器和 PNG 长图导出。默认使用内置演示内容；配置兼容接口后可生成真实分镜和图片。

## 启动

需要 Node.js 20 或更新版本。在此文件夹运行：

```sh
node server.mjs
```

访问 `http://localhost:4173`。首次启动会在 `data/state.json` 创建本地数据文件。设置 `PORT` 可更改端口。

## 接入模型

复制 `.env.example` 为 `.env`，填入模型服务商提供的地址、密钥和模型名称，然后重启服务。密钥仅由本地 Node 服务读取，不会发送到浏览器，也不要提交 `.env`。

- 分镜使用 OpenAI 兼容的 `POST {LLM_BASE_URL}/chat/completions`，模型需支持 JSON object 响应格式。
- 绘图使用 OpenAI 兼容的 `POST {IMAGE_BASE_URL}/images/generations`，返回 PNG/JPEG/WebP 的 base64 数据或可下载图片地址。
- `LLM_PROVIDER=mock` 或 `IMAGE_PROVIDER=mock` 可分别关闭对应的真实模型。对应配置缺失时也会回退到演示模式。
- 通过 `GET /api/v1/config` 可查看是否已连接；此接口不返回密钥。

不同服务商对模型名、尺寸参数和响应格式的支持可能不同，需按其兼容接口文档填写。生成的图片存放在 `data/assets/`，作品和角色存放在 `data/state.json`。

## 演示流程

1. 打开预置作品《今天一定准时下班》，进入工作台。
2. 在左侧选择画格，在右侧修改画面描述、动作、对白和旁白。
3. 点击“生成这一格”保存画面版本；配置绘图模型后会显示真实生成的图片，未配置时保留内置演示画面。
4. 点击“生成分镜”按当前作品格数生成故事，可逐格编辑。
5. 调整比例和间距，选择“导出长图”下载 PNG。
6. 在角色库新增角色，在作品库复制、归档或删除作品。

## 本地 API

- `GET /api/v1/health`：健康状态与安全的模型连接状态
- `GET /api/v1/config`：模型连接状态，不含密钥
- `GET/PUT /api/v1/state`：读写本地工程状态
- `GET /api/v1/works`、`GET /api/v1/characters`：作品和角色列表
- `POST /api/v1/jobs`、`GET /api/v1/jobs/:id`、`POST /api/v1/jobs/:id/cancel`：异步任务队列

服务默认只绑定 `127.0.0.1`，尚未包含用户登录、云端同步、生产数据库和多租户权限。请勿把本地服务直接暴露到公网。清理 `data/` 会删除服务器上的本地作品和生成图片。
