# 个人云存储（Personal Vault）

一个单机部署、前后端同仓库的个人文件管理系统。项目使用 Node.js 原生 HTTP 服务、SQLite 和原生 HTML/CSS/JavaScript，不依赖前端框架，也没有第三方 npm 运行时依赖。

## 目录

- [功能概览](#功能概览)
- [技术栈](#技术栈)
- [架构与请求流程](#架构与请求流程)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [常用命令](#常用命令)
- [数据存储与备份](#数据存储与备份)
- [视频 720P 预览副本](#视频-720p-预览副本)
- [隐私空间](#隐私空间)
- [HTTP API](#http-api)
- [安全设计与限制](#安全设计与限制)
- [部署方式](#部署方式)
- [测试与验证](#测试与验证)
- [已知边界与待确认事项](#已知边界与待确认事项)
- [许可证](#许可证)

## 功能概览

| 能力 | 当前实现 |
|---|---|
| 用户体系 | 邮箱 + 密码注册、登录、退出、修改账号密码 |
| 注册控制 | 通过 `config.json` 的 `registrationCode` 决定必须填写注册码还是开放注册 |
| 文件分类 | 服务端根据扩展名 / MIME 自动归入照片、视频、音乐、文件；SVG 按普通文件处理 |
| 上传 | 选择或拖拽、多选、8MiB 分块续传、暂停 / 继续 / 取消、SHA-256 内容去重 |
| 文件列表 | 分类、文件名搜索、四种排序、分页加载 |
| 预览 | 图片缩放 / 平移 / 相邻预加载、自定义音频播放器、视频 720P / 原画切换 |
| 媒体封面 | FFmpeg 生成并缓存照片 / 视频小尺寸 JPEG；失败时回退原图或视频取帧 |
| 视频流 | HTTP Range、206 分段响应、ETag、慢速缓冲状态与有限次数自动重连 |
| 下载 | 保留原始文件名；支持 Range 分块下载、暂停 / 继续 / 取消；不支持 File System Access API 时回退普通下载 |
| 回收站 | 普通文件软删除、24 小时内恢复、到期或手动彻底删除 |
| 隐私空间 | 独立隐私密码、账号密码验证重置、短时解锁、隐私文件永久删除 |
| 备案信息 | 可在前端配置中开启 ICP 备案页脚，显示备案号并链接工信部备案查询 |
| 存储统计 | 普通用量、分类用量、回收站和隐私空间独立展示；配额包含回收站与隐私文件 |
| 部署 | 单进程一体部署，或静态前端 + 独立 API 的跨域部署 |
| 传输中心 | 独立传输页集中显示上传 / 下载任务、进度、速度、状态和批量操作 |
| 响应式 | 桌面侧栏、平板和手机布局 |

### 预览与媒体

- 图片：0.5x–8x 缩放，滚轮 / 双指 / 双击缩放，高倍率下拖动平移；灯箱按当前筛选结果左右切换。
- 音频：页面内自定义播放器，支持播放、暂停、进度和音量。
- 视频：优先请求 720P 副本 `/api/files/:id/preview`；没有合格副本时播放原始文件 `/api/files/:id/raw`。
- 媒体封面：照片和视频列表都优先请求 `/api/files/:id/thumbnail`，由服务端生成并缓存小尺寸 JPEG，避免反复下载大图或视频数据。
- 视频拖动：服务端解析 `Range`，默认把单次 206 响应限制在 32MiB，降低超长连接占用。
- 媒体缓存：响应带 ETag、Last-Modified 和私有缓存头，减少重复 Range 请求。
- 卡顿恢复：连续约 8 秒没有新数据时才尝试重连，单次播放最多自动重连两次。

### 上传与去重

- 请求体直接发送文件二进制，不使用 multipart 表单。
- 文件名通过查询参数传入；分类始终由服务端判断。
- 同一用户下，内容 SHA-256 相同的文件只保留一份；普通文件、回收站和隐私文件共同参与去重。
- 命中隐私文件去重时，接口只返回通用提示，不泄露隐私文件名和元数据。
- 用户配额、磁盘余量和流式计数三层限制共同阻止超量写入。
- 每个用户最多同时上传 4 个文件，进程总计最多 32 个。
- 上传进度提示支持长文件名自动换行，最多显示三行，并保留完整名称供悬停查看。

#### 传输中心与断点续传

- 侧栏「传输」页面集中显示正在上传、正在下载以及最近完成或失败的传输任务，支持暂停、继续、取消、全部暂停、全部继续和清除已完成记录。
- 新上传使用 `POST /api/uploads` 创建会话，再以 8MiB 分块发送；服务端在 `data/upload-sessions/<ownerId>/` 保存临时的 `.part` 文件和会话元数据。
- 上传会话 24 小时无活动后过期，由回收站清扫任务一并清理。每用户最多同时保留 4 个上传会话，前端默认并发 2 个；服务端繁忙时任务会留在队列中自动重试，而不是显示成片失败。
- 会话在创建时会预留完整文件大小；容量判断会同时计入已用空间、其它未完成会话的预留空间和新会话大小。
- 每个分块只在完整写盘后原子更新偏移量；异常中断时会把 `.part` 截断回最后一次确认的偏移，避免重复或损坏内容进入正式文件。
- 页面刷新后仍会显示未完成上传，但浏览器无法静默重新获取本地 File 对象，必须重新选择文件名、大小和修改时间一致的原文件后才能续传。
- 可续传下载使用浏览器 File System Access API 和 HTTP `Range`，每段 8MiB，直接写入用户选择的本地文件；暂停后从已确认偏移继续。
- 下载任务元数据保存在 `localStorage`，文件句柄保存在 IndexedDB。刷新页面后，浏览器可能要求重新授予目标文件写入权限。
- Firefox 或未启用 File System Access API 的浏览器会回退为浏览器自身的普通下载；普通下载无法在页面内暂停或续传。
- 上传和下载任务都只记录传输元数据，不记录文件内容；服务端临时文件仍需遵守磁盘空间和用户配额限制。
- 隐私传输任务在隐私空间锁定时会自动暂停并隐藏，重新解锁后才恢复显示。

## 回收站

- 普通文件删除时只写 `deleted_at`，不会立即删除磁盘文件。
- 24 小时内可恢复；后台每 10 分钟扫描一次过期记录并清理。
- 容量统计和上传配额包含回收站文件，避免“先删除再上传”绕过限制。
- 隐私文件删除是永久删除，不进入回收站。

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js `>=22.5`，ES Modules |
| HTTP | `node:http`，无 Web 框架 |
| 数据库 | 内置 `node:sqlite`，SQLite WAL 模式 |
| 密码与令牌 | `node:crypto` scrypt、HMAC-SHA256、HttpOnly Cookie |
| 前端 | 原生 HTML、CSS、JavaScript，无打包步骤 |
| 文件流 | `node:fs`、`node:stream`、HTTP Range |
| 视频转码 | 可选 FFmpeg（libx264 + AAC） |
| 运行时依赖 | 无第三方 npm 依赖 |
| 许可证 | MIT |

## 架构与请求流程

```text
浏览器
  │
  ├─ GET /、/styles.css、/app.js、/transfers.js …… ──> server.js ──> lib/static.js
  │
  └─ /api/** ─────────────────────────> lib/api.js
                                           ├─ lib/config.js       部署、CORS、Cookie、容量
                                           ├─ lib/rate-limit.js   单进程内存限流
                                           ├─ lib/auth.js         密码哈希、签名令牌、Cookie
                                           ├─ lib/store.js        参数化 SQL 数据访问
                                           ├─ lib/media.js        MIME 与分类
                                           ├─ lib/video-preview.js 可选视频预览转码
                                           └─ lib/media-thumbnail.js 照片 / 视频封面生成与缓存
                                                   │
                                                   └─ lib/db.js ──> data/vault.db
                                                                 └─ data/uploads/
                                                                 └─ data/previews/
```

关键设计：

- `server.js` 只负责进程启动、安全响应头、CORS / API / 静态资源分流和优雅退出。
- `lib/api.js` 集中处理认证、文件、回收站、隐私空间与分块上传接口；`lib/upload-session.js` 管理可续传临时会话。
- `public/app.js` 负责主界面和文件列表，`public/transfers.js` 独立维护上传 / 下载任务队列与传输页。
- `lib/store.js` 封装全部 SQL，文件查询都带 `owner_id` 条件。
- 普通登录 Cookie 与隐私解锁 Cookie 分离；隐私文件需要同时满足登录和隐私解锁校验。
- 原文件只读。视频 720P 副本单独存放，删除原文件时同步清理副本。
- 当前没有前端路由，除 `/` 和实际存在的静态文件外，未知路径直接 404。

## 目录结构

```text
.
├─ server.js                         HTTP 服务入口
├─ package.json                      Node 版本与 npm scripts
├─ config.example.json               注册码配置模板
├─ config.json                       首次启动自动生成，含注册码，不入 Git
├─ LICENSE                           MIT License
├─ README.md
├─ lib/
│  ├─ api.js                         认证、文件、分块上传、回收站、隐私空间 API
│  ├─ upload-session.js              断点续传上传会话、临时分块与过期清理
│  ├─ auth.js                        scrypt 哈希、HMAC 令牌、Cookie
│  ├─ config.js                      模式、CORS、Cookie、容量和站点配置
│  ├─ cors.js                        CORS 响应与 OPTIONS 预检
│  ├─ db.js                          SQLite 建表、迁移、索引
│  ├─ media.js                       MIME 推断、分类、安全内联类型
│  ├─ paths.js                       项目与数据目录常量
│  ├─ rate-limit.js                  内存固定窗口限流
│  ├─ static.js                      public/ 静态资源、ETag、CSP
│  ├─ store.js                       参数化 SQL 数据访问层
│  ├─ video-preview.js               可选视频 720P 预览生成与跳过标记
│  └─ media-thumbnail.js             照片 / 视频封面生成、缓存与回退
├─ public/
│  ├─ index.html
│  ├─ app.js                         主界面、登录、文件列表、预览与文件操作
│  ├─ transfers.js                   上传 / 下载任务队列与传输页面
│  ├─ styles.css
│  ├─ config.js                      前端 API 地址配置
│  └─ favicon.svg
├─ scripts/
│  └─ optimize-video-previews.mjs    批量 / 单个视频预览生成
└─ data/                             运行时生成，不入 Git
   ├─ vault.db
   ├─ uploads/<ownerId>/
   ├─ previews/<ownerId>/
   └─ secret.key
```

Unix 系统上，`data/` 和 `uploads/` 会尝试收紧到 `0700`，数据库与 `secret.key` 到 `0600`。Windows 可能忽略 Unix 权限位。

## 环境要求

### 必需

- Node.js **22.5 或更高**。项目使用 `node:sqlite`；低于该版本会直接提示升级并退出。
- 一个可写的项目目录，用于生成 `config.json` 和 `data/`。
- 支持现代 ES Modules、Fetch、Pointer Events 的浏览器。
- 页面内可暂停 / 续传的下载依赖 File System Access API（Chrome / Edge 等）；不支持时自动回退普通下载。

### 可选

- FFmpeg：用于生成 720P / 原画切换所需的播放副本。未安装时视频直接使用原文件。
- Nginx / Caddy / Cloudflare：生产环境反向代理、HTTPS、限速和 WAF。
- `sqlite3` 命令行工具：仅用于手工在线备份，不是运行依赖。

项目没有 `node_modules` 依赖，因此**正常启动不需要 `npm install`**。

## 快速开始

### Linux / macOS

```bash
node -v
npm start
```

或：

```bash
node server.js
```

### Windows PowerShell

```powershell
node -v
npm start
```

指定端口：

```powershell
$env:PORT=8788
node server.js
```

Linux / macOS：

```bash
PORT=8788 node server.js
```

首次启动会自动：

1. 创建 `config.json` 并生成随机注册码（如果文件不存在）。
2. 创建 `data/`、`data/uploads/`、`data/previews/` 和 `data/vault.db`。
3. 执行建表、索引和必要的数据迁移。
4. 在控制台打印注册码、部署模式和数据库统计。
5. 启动回收站定时清扫。

默认监听 `0.0.0.0:8787`，浏览器访问：

```text
http://localhost:8787
```

> 项目不会自动读取 `.env` 文件。环境变量必须由当前 shell、systemd、容器或反向代理进程注入。

## 配置说明

### 1. `config.json`：注册策略

首次启动自动生成：

```json
{
  "registrationCode": "VAULT-XXXX-XXXX-XXXX"
}
```

| 值 | 行为 |
|---|---|
| 非空字符串 | 注册时必须填写正确注册码 |
| 空字符串 | 开放注册，前端隐藏注册码输入框 |
| 文件缺失 | 自动生成随机注册码 |
| JSON 无法解析 | 启动失败，不会静默降级为开放注册 |

注册码比较会忽略首尾空格和大小写。`config.json` 已加入 `.gitignore`；仓库只保留 `config.example.json`。

### 2. `public/config.js`：前端 API 地址

一体部署保持：

```js
window.VAULT_CONFIG = {
  apiBase: '',
  icp: {
    enabled: false,
    number: '',
    url: 'https://beian.miit.gov.cn/',
  },
}
```

分离部署改为：

```js
window.VAULT_CONFIG = {
  apiBase: 'https://api.example.com',
  icp: {
    enabled: false,
    number: '',
    url: 'https://beian.miit.gov.cn/',
  },
}
```

由于 HTML CSP 为 `script-src 'self'`，不能在 `index.html` 中通过内联 `<script>` 覆盖该配置。必须修改或替换 `public/config.js`。

启用备案页脚：

```js
icp: {
  enabled: true,
  number: '京ICP备12345678号-1',
  url: 'https://beian.miit.gov.cn/',
}
```

只有 `enabled` 为 `true` 且 `number` 非空时才显示页脚；备案号会以纯文本插入，链接只接受 `http:` / `https:`，非法地址回退到工信部备案查询页。

### 静态资源缓存

- `index.html` 继续使用 `no-cache, must-revalidate`，确保部署后立即读取新版页面。
- `config.js` 可能独立修改备案信息或 API 地址，因此也保持实时校验。
- 带 `?v=` 版本参数的 `app.js`、`transfers.js`、`styles.css` 和图标使用一年期 `immutable` 强缓存。
- 发布新版本时必须同步更新 `package.json`、`APP_VERSION` 和 `index.html` 中的 `?v=`。
- 这样升级后会自动使用新 URL，同时快速刷新不会重复下载未变化的脚本和样式。
- 登录状态确认后，主界面、普通文件列表和隐私锁定请求并行执行；进入隐私空间前仍会等待锁定完成，兼顾刷新速度与安全。

### 3. 环境变量

#### 服务与部署

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP 监听端口；监听地址固定为 `0.0.0.0` |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的前端 Origin，启用跨域 CORS |
| `SERVE_STATIC` | 启用 | 设为 `0` 时本进程只提供 API，不托管 `public/` |
| `TRUST_PROXY` | 关闭 | 仅当值严格等于 `1` 时信任 `CF-Connecting-IP` / `X-Forwarded-For` |

#### 存储与上传

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MAX_USER_BYTES` | `10GiB` | 每用户总容量；`0` 表示不限制 |
| `MIN_FREE_BYTES` | `1GiB` | 磁盘保留余量；低于此值拒绝上传 |
| `MAX_UPLOAD_BYTES` | `2GiB` | 单文件上限 |
| `UPLOAD_IDLE_TIMEOUT_MS` | `60000` | 上传连续无数据多久后断开 |
| `MEDIA_RANGE_CHUNK_BYTES` | `32MiB` | 单次 206 响应上限，代码限制在 1–64MiB |

`MAX_USER_BYTES`、`MIN_FREE_BYTES` 等数值变量应传入有效数字。当前代码不会对 `NaN` 给出启动错误。

#### 视频预览

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件路径 |
| `AUTO_VIDEO_PREVIEW` | 启用 | 设为 `0` 禁止新上传视频自动排队生成预览 |
| `VIDEO_PREVIEW_TIMEOUT_MS` | `7200000` | 服务端自动转码超时；`0` 表示不限制 |
| `VIDEO_PREVIEW_THREADS` | `2` | FFmpeg 线程数；命令行脚本传入 `0` 让 FFmpeg 自动选择 |
| `VIDEO_PREVIEW_CRF` | `26` | H.264 CRF，范围 0–51 |
| `VIDEO_PREVIEW_MAXRATE_KBPS` | `2200` | 视频峰值码率上限 |
| `VIDEO_PREVIEW_AUDIO_KBPS` | `96` | AAC 音频码率 |

> `X-Forwarded-Proto` 在协议判断和 Secure Cookie 判断中会被读取。生产环境应只通过受信任反向代理访问，并由代理覆盖该头。启用 `TRUST_PROXY=1` 时，代理还必须覆盖而不是追加客户端提供的 `X-Forwarded-For`，否则限流 IP 可被伪造。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm start` | 启动 HTTP 服务 |
| `node server.js` | 直接启动，等价于 `npm start` |
| `npm run preview:videos` | 为所有未删除视频尝试生成 / 复用 720P 副本 |
| `npm run preview:video -- "文件名或文件ID"` | 处理指定视频 |
| `npm run preview:videos -- --force` | 忽略已有副本和跳过标记，强制重新转码 |
| `npm run preview:video -- "文件名" --force` | 强制处理单个视频 |

示例：

```bash
npm run preview:video -- "示例视频.mp4"
npm run preview:video -- "7b694feb-ca1b-4e6b-a665-c146c43cd0ff"
```

## 数据存储与备份

### 运行时文件

| 路径 | 用途 |
|---|---|
| `data/vault.db` | 用户、文件元数据、隐私状态、哈希与版本 |
| `data/uploads/<ownerId>/` | 原始文件，磁盘名由随机 UUID + 安全扩展名组成 |
| `data/upload-sessions/<ownerId>/` | 未完成上传的会话元数据和 `.part` 临时文件；24 小时无活动后自动清理 |
| `data/previews/<ownerId>/<fileId>.mp4` | 可选 720P 播放副本 |
| `data/previews/<ownerId>/<fileId>.mp4.skip.json` | 已确认“无法生成更小副本”的跳过标记 |
| `data/previews/<ownerId>/<fileId>.thumb.jpg` | 照片 / 视频列表封面缓存，最大 640px |
| `data/secret.key` | 会话和隐私令牌 HMAC 密钥 |
| `config.json` | 注册码配置 |

### 备份

推荐在停止服务后备份：

```text
data/
config.json
```

`data/previews/` 可以备份，也可以不备份；删除后可按需重新生成。`data/secret.key` 丢失会让已有令牌失效，用户需要重新登录。

如果要在服务运行时使用 SQLite 在线备份，并且系统安装了 `sqlite3`：

```bash
sqlite3 data/vault.db ".backup 'backup.db'"
```

同时仍需单独备份 `data/uploads/`、`data/previews/`、`data/secret.key` 和 `config.json`。

### 单实例约束

一个 `data/` 目录只应运行一个应用实例。限流和上传并发限制保存在进程内存中；多实例还会重复执行回收站清扫并增加 SQLite 锁竞争。

## 视频 720P 预览副本

视频预览是可选功能，必须安装 FFmpeg。原始文件始终不被修改，下载和 MD5/SHA-256 保持一致。

### 生成策略

- 输出为最高 720p 的 H.264 MP4，AAC 音频，并启用 fast-start。
- 默认使用 CRF 26，而不是固定平均码率；`maxrate` 继续限制带宽峰值。
- 如果输入宽度或高度不足 1280×720，不会主动放大。
- 临时文件达到原片大小时立即终止。
- 最终副本必须小于原片才会保留；否则删除并写入 `.skip.json`。
- 跳过标记记录原片大小、修改时间、CRF、峰值码率和音频码率。参数或原片变化后会自动失效。
- 普通批处理遇到有效跳过标记时不会重复编码；`--force` 可强制重试。
- 720P 副本不计入用户原始文件配额，但会额外占用服务器磁盘。
- 删除原文件、回收站彻底删除和隐私文件永久删除都会同步清理预览、封面和跳过标记。

### 照片与视频封面缩略图

- 新上传的照片和视频会在后台尝试生成封面。
- 卡片封面优先读取服务端缓存的 JPEG，不再直接加载大照片或从视频取帧。
- 照片缩略图最大 640×640，视频缩略图最大 640×360，使用 7 天私有浏览器缓存。
- 首次请求时如果封面不存在，会串行调用 FFmpeg 生成，避免同时启动多个转码进程。
- FFmpeg 不可用或生成失败时，照片回退原图，视频回退到原来的 `<video>` 取帧。
- 原文件删除时会同步清理封面缓存。

### FFmpeg 安装

Debian / Ubuntu：

```bash
sudo apt update
sudo apt install -y ffmpeg
ffmpeg -version
```

## 隐私空间

隐私空间是**应用层访问隔离**，不是磁盘加密。它用于在已登录页面中隐藏部分文件并要求再次验证，不能对抗服务器管理员、备份系统、屏幕录制或已控制操作系统的攻击者。

### 行为

- 首次进入时设置 8–128 位独立隐私密码，服务端只保存 scrypt 盐和哈希。
- 普通文件可从卡片或灯箱移入隐私空间；在隐私空间发起的上传直接保存为隐私文件。
- 隐私文件不会出现在普通列表、分类、搜索、回收站或普通用量统计中。
- 隐私文件仍计入账号总配额。
- 访问隐私文件的原文件、下载和视频预览都要求有效隐私 Cookie。
- 隐私空间内删除为永久删除。

### 重新验证时机

- 页面刷新、重新打开或从浏览器前进 / 后退缓存恢复。
- 前端连续 10 分钟无操作。
- 主动退出隐私空间或切换到回收站。
- 退出登录、切换账号、修改账号密码。
- 服务端 15 分钟隐私令牌过期。

浏览、点击、输入、滚动、上传进度和媒体播放都会刷新前端空闲计时。媒体播放期间会节流发送 `/api/privacy/heartbeat`，续签服务端隐私令牌。

### 隐私密码重置

1. 在解锁弹窗点击“忘记隐私密码？”。
2. 输入当前账号密码。
3. 设置并确认新隐私密码。

重置成功后，`privacy_version` 递增，其它浏览器上的隐私解锁令牌立即失效；当前浏览器获得新的短时隐私 Cookie。已有隐私文件不受影响。

如果账号密码也忘记，当前版本没有网页端账号找回流程。

## HTTP API

API 默认返回 JSON，错误格式为：

```json
{
  "error": "可读错误信息",
  "code": "MACHINE_READABLE_CODE"
}
```

浏览器身份主要通过 HttpOnly Cookie；服务端也接受 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/config` | 是否需要注册码 |
| POST | `/api/auth/register` | 注册并登录 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 退出并清除普通 / 隐私 Cookie |
| GET | `/api/auth/me` | 当前用户 |
| PATCH | `/api/auth/password` | 修改账号密码，撤销旧会话 |
| GET | `/api/files` | 普通文件列表：`category` / `q` / `sort` / `limit` / `offset` |
| POST | `/api/files/upload?name=...` | 兼容接口：一次性流式上传；隐私视图附加 `private=1` |
| POST | `/api/uploads` | 创建可续传上传会话，返回会话 ID、偏移量和分块大小 |
| GET / HEAD | `/api/uploads/:id` | 查询上传会话的当前偏移量和过期时间 |
| PATCH | `/api/uploads/:id` | 追加一个分块；请求头使用 `Upload-Offset`，最后一块完成后自动入库 |
| DELETE | `/api/uploads/:id` | 取消上传会话并删除临时文件 |
| GET / HEAD | `/api/files/:id/raw` | 原始文件，支持 Range |
| GET / HEAD | `/api/files/:id/download` | 附件下载，支持 Range |
| GET / HEAD | `/api/files/:id/preview` | 720P 副本；不存在时回退原文件 |
| GET / HEAD | `/api/files/:id/thumbnail` | 照片 / 视频封面 JPEG；首次按需生成并缓存 |
| PATCH | `/api/files/:id` | 普通文件改名 / 改分类 |
| DELETE | `/api/files/:id` | 普通文件移入回收站 |
| POST | `/api/files/:id/restore` | 从回收站恢复 |
| GET | `/api/trash` | 回收站列表 |
| DELETE | `/api/trash/:id` | 彻底删除单个回收站文件 |
| DELETE | `/api/trash` | 清空回收站 |
| POST | `/api/privacy/setup` | 首次设置隐私密码 |
| POST | `/api/privacy/unlock` | 隐私密码解锁 |
| POST | `/api/privacy/reset` | 账号密码验证后重置隐私密码 |
| POST | `/api/privacy/lock` | 立即锁定隐私空间 |
| POST | `/api/privacy/heartbeat` | 续签隐私 Cookie |
| GET | `/api/privacy/files` | 隐私文件列表 |
| POST | `/api/privacy/files/:id` | 移入隐私空间 |
| POST | `/api/privacy/files/:id/move-out` | 移出隐私空间 |
| DELETE | `/api/privacy/files/:id` | 永久删除隐私文件 |

列表响应结构：

```json
{
  "files": [],
  "usage": {},
  "page": {
    "limit": 60,
    "offset": 0,
    "total": 0,
    "hasMore": false
  }
}
```

`limit` 上限为 200，默认 60。

## 安全设计与限制

### 已实现

- 密码使用随机盐 + scrypt；账号密码和隐私密码独立保存。
- 会话使用 HMAC-SHA256 签名 HttpOnly Cookie，有效期 30 天。
- 令牌包含会话版本；修改账号密码会撤销其它旧登录令牌。
- 隐私令牌额外包含 `scope`、隐私密码版本和会话版本。
- 所有文件 SQL 查询按 `owner_id` 过滤；他人文件按 404 处理。
- 文件名不直接用于磁盘路径；磁盘名使用随机 UUID + 安全扩展名。
- HTML / SVG / XML / PDF 等主动内容不会安全内联，统一按附件下载。
- 静态文件防目录穿越；HTML 设置 CSP；全站设置 `nosniff`、`SAMEORIGIN`、Permissions-Policy。
- CSP 仅放行 Cloudflare Web Analytics 的官方脚本和上报域名，不使用 `unsafe-inline`。
- 浏览器请求校验 Origin / Sec-Fetch-Site；跨域来源必须列入 `ALLOWED_ORIGINS`。
- 上传使用流式计数和空闲超时，超限会删除半成品。
- 分块上传会话按用户隔离；临时文件使用 `0600`、会话目录使用 `0700` 权限位（Windows 忽略 POSIX 权限位）。
- 上传会话在完整写盘后才推进偏移量；中断时会回滚未确认的分块，最终文件仍使用原内容哈希去重。
- 隐私文件重复上传提示不会泄露私有名称。

### 内存限流

限流器为单进程固定窗口，重启后清空：

| 场景 | 限制 |
|---|---|
| 普通 API | 每 IP 600 次/分钟 |
| 媒体 Range 请求 | 每 IP 3000 次/分钟 |
| 登录 IP | 120 次/15 分钟 |
| 单账号登录尝试 | 10 次/15 分钟 |
| 注册 | 每 IP 10 次/小时 |
| 修改账号密码 | 每用户 10 次/15 分钟 |
| 隐私设置 / 解锁 / 重置 | 每用户各 10 次/15 分钟 |
| 创建上传会话 | 每用户 120 次/小时 |
| 上传分块 | 每用户 5000 次/小时 |
| 并发上传 | 每用户 4 个，进程总计 32 个；前端默认并发 2 个，繁忙时自动排队重试 |

生产环境仍应在 Nginx / Cloudflare 层配置连接数、请求速率和 DDoS 防护。

### 安全边界

- 隐私空间不是磁盘加密，上传文件和数据库均未在磁盘上加密。
- 项目不进行病毒扫描；不要公开分享下载链接。
- `config.json` 注册码为空时，任何能访问注册页的人都可注册。
- 如果签名密钥或数据库泄露，已有会话和隐私边界都可能失效。
- 多进程部署会绕过当前内存限流的上限语义，应保持单实例。
- `node:sqlite` 仍是实验性 API，升级 Node 主版本前应做兼容性验证。

## 部署方式

### 方式一：一体部署

Node 进程同时提供静态前端和 API：

```bash
PORT=8787 node server.js
```

建议由 Nginx / Caddy 处理 HTTPS，并反向代理到 `127.0.0.1:8787`。

### 方式二：静态前端 + 独立 API

前端可部署到静态托管或 CDN，后端只运行 API：

后端：

```bash
SERVE_STATIC=0 \
ALLOWED_ORIGINS=https://vault.example.com \
PORT=8787 \
node server.js
```

前端 `public/config.js`：

```js
window.VAULT_CONFIG = {
  apiBase: 'https://api.example.com',
}
```

要求：

- 前后端都使用 HTTPS。
- `ALLOWED_ORIGINS` 必须写完整 Origin，不包含路径和末尾 `/`。
- 后端跨域模式下 Cookie 使用 `SameSite=None; Secure`。
- 静态托管方需自行设置 CSP，至少允许前端访问 API 的 `connect-src`、`img-src` 和 `media-src` 域名。
- 后端内置 HTML CSP 只包含 `'self'`，不能直接用于“静态页与 API 不同源”却不调整静态托管的 CSP 配置。

### systemd 示例

```ini
[Unit]
Description=Personal Vault
After=network.target

[Service]
Type=simple
User=vault
Group=vault
WorkingDirectory=/opt/personal-vault
Environment=PORT=8787
Environment=MAX_USER_BYTES=10737418240
Environment=TRUST_PROXY=1
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

上述服务文件是部署示例，路径、用户和 Node 位置需按服务器实际环境调整。

### Nginx 示例

```nginx
server {
    listen 80;
    server_name vault.example.com;

    # 必须覆盖客户端传入的转发头，避免伪造来源 IP / 协议。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;

    # 默认 1m 会拦截大文件上传，应与 MAX_UPLOAD_BYTES 协调。
    client_max_body_size 2g;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}
```

生产环境应补充 TLS、HTTP/2 或 HTTP/3、安全响应头和访问日志。示例未在仓库中自动验证。

## 测试与验证

当前仓库**没有自动化测试套件、测试目录或 `npm test` 脚本**，也没有 ESLint / Prettier 配置。以下命令可作为提交前的最低静态验证。

### PowerShell

```powershell
node --check server.js
Get-ChildItem lib -Filter *.js | ForEach-Object { node --check $_.FullName }
node --check public/app.js
node --check public/transfers.js
node --check scripts/optimize-video-previews.mjs
git diff --check
```

### Bash

```bash
node --check server.js
for file in lib/*.js; do node --check "$file" || exit 1; done
node --check public/app.js
node --check public/transfers.js
node --check scripts/optimize-video-previews.mjs
git diff --check
```

### 手工冒烟检查

1. 首次启动生成 `config.json` 和 `data/`。
2. 注册、退出、重新登录。
3. 上传照片、视频、音乐、普通文件并确认分类。
4. 测试搜索、排序、分页、重命名和下载。
5. 上传大于 16MiB 的文件，在首个分块后暂停，确认继续后下载内容的 SHA-256 与原文件一致。
6. 刷新页面后重新选择原文件，确认上传从服务端已有偏移继续；取消任务后确认临时会话消失。
7. 在支持 File System Access API 的浏览器下载大文件，暂停、继续并校验目标文件 SHA-256；再验证不支持该 API 时的普通下载回退。
8. 普通文件删除到回收站、恢复、彻底删除。
9. 大照片与视频封面缓存、图片缩放 / 平移、音频播放、视频拖动和清晰度切换。
10. 设置隐私密码、移入 / 移出隐私文件，确认普通列表不可见。
11. 刷新页面后确认隐私空间重新锁定。
12. 修改账号密码后确认旧隐私解锁失效。
13. 验证 FFmpeg 可用和不可用两种视频播放路径。

## 已知边界与待确认事项

- 项目没有自动化测试；接口、浏览器端和跨域行为仍主要依赖人工验证。
- HTTPS、Nginx、systemd、Cloudflare 和不同浏览器 / 移动设备组合未在本仓库内自动验证。
- 跨域部署需要静态托管平台额外配置 CSP 和 CORS；仓库只提供后端侧 CORS。
- `node:sqlite` 的实验性 API 兼容性需要随 Node 版本升级持续确认。
- 账号密码没有网页端找回流程；隐私密码只能在仍记得账号密码时重置。
- 没有文件病毒扫描、内容审核、版本历史、文件夹层级或分享链接。
- 单进程限流不适用于多实例部署。
- 页面内断点续传下载依赖 File System Access API；Firefox / Safari 等回退路径无法显示浏览器自身的实时下载进度。
- 页面刷新后上传任务必须重新选择原文件，下载任务能否无提示继续取决于浏览器对已保存文件句柄权限的策略。
- `MAX_USER_BYTES` / `MIN_FREE_BYTES` 等环境变量缺少非法数值启动校验，部署时需人工确认。

## 许可证

MIT，详见 `LICENSE`。