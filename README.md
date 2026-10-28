# 个人云存储（Personal Vault）

管理个人仓库中的**视频 / 照片 / 文件**的一体化存储站点。

## 功能

| 能力 | 说明 |
|---|---|
| 用户体系 | 邮箱 + 密码注册 / 登录 / 退出 / 修改密码 |
| 数据隔离 | 每条记录归属服务端写入，接口按归属过滤，跨用户访问一律返回「不存在」 |
| 分类归档 | 上传时按 MIME 与扩展名自动归入 **照片 / 视频 / 音乐 / 文件**，不受当前筛选页面影响 |
| 上传 | 点击选择或拖拽，支持多选、进度条、SHA-256 内容去重与 2GB 大文件流式写入 |
| 下载 | 保留原始文件名，支持 HTTP Range（视频可拖动进度条） |
| 预览 | 图片灯箱（0.5x–8x 缩放、相邻预加载、左右切换）、视频 720P/原画切换、自定义音乐播放器 |
| 回收站 | 删除后自动进入回收站，24 小时内可恢复，到期自动彻底清除 |
| 检索 | 文件名搜索（防抖）、四种排序、分类计数与含回收站的存储用量统计 |
| 响应式 | 桌面双栏 → 平板单栏 → 手机底部操作条，逐级适配 |

---

### 预览切换

预览窗口会按照当前筛选和排序结果快速切换：

- 点击图片左右两侧的箭头切换上一个 / 下一个文件。
- 键盘 `←` / `→` 也可以切换；图片放大后，方向键优先用于平移，按 `0` 回到适应窗口后可继续切换。
- 标题下方会显示当前位置，例如 `3 / 11`。
- 当前页最后一个文件还有下一页时，会自动加载下一页再继续切换。
- 切换音视频时会先暂停上一条，避免后台同时播放。

### 视频与照片加载优化

- 视频继续使用 HTTP Range，只请求拖动位置附近的数据；响应增加内容 ETag、Last-Modified 和 1 小时私有缓存，重复拖动时可以复用已下载片段。
- 服务端读取视频切片的块大小提高到 256 KB，减少频繁小块读取和系统调用。
- 视频加载、缓冲、拖动定位时显示明确状态；只有连续 8 秒完全没有收到新数据时才自动重连，并恢复到原播放位置。
- 浏览器经常请求“从某个位置一直读到文件末尾”。服务端默认把单个 206 响应控制在 32MB，兼顾高延迟网络连续播放和连接数量；可用 MEDIA_RANGE_CHUNK_BYTES 调整。
- 媒体流使用独立的 3000 次/分钟限流，避免视频预缓冲和 Range 请求被普通 API 的 600 次/分钟限流误伤。
- 预览照片时会预先加载前后各两张照片；相邻视频只预取 metadata，减少左右切换等待，同时避免后台下载大量视频。

### 低码率播放副本

阿里云轻量服务器常见公网上行只有几 Mbps，而高码率原视频可能持续需要 10–20 Mbps。
HTTP Range、缓存和 Nginx 只能降低额外开销，不能突破物理带宽，因此项目增加了独立的视频播放入口：

- 原文件永远不改动，下载仍保持原始 MD5/SHA-256。
- 视频灯箱提供“720P / 原画”两档选择，切换时保留播放位置和播放状态。
- 默认优先使用 720P；720P 请求 `/api/files/:id/preview`，原画请求原始文件 `/raw`。
- 如果 720P 副本尚未生成，播放器自动回退原画并禁用 720P 选项。
- 如果存在低码率 fast-start 预览副本，就播放副本；如果不存在，自动回退原始视频。
- 720P 选项在预览副本尚未生成时显示为不可选，生成后刷新页面即可使用。
- 新上传的视频在服务器安装 ffmpeg 后会自动排队生成预览。
- 已有视频可手动批量生成：

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y ffmpeg

# 为全部已有视频生成
npm run preview:videos

# 或只处理一个文件（文件名或文件 ID）
npm run preview:video -- "B260912弱柳扶风118s.mp4"
```

默认预览参数为最高 720p、H.264 约 1.8Mbps、AAC 96kbps，适合约 3–5Mbps 的公网上行。

预览副本会额外占用磁盘空间，但不计入原始文件配额；彻底删除原文件时会同步清理预览副本。ffmpeg 处理的是用户上传内容，生产环境应保持 ffmpeg 更新，并让服务以最小权限账号运行。
可通过环境变量调整：

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg 可执行文件路径 |
| `AUTO_VIDEO_PREVIEW` | 启用 | 设为 `0` 禁止新上传自动生成 |
| `VIDEO_PREVIEW_TIMEOUT_MS` | 900000 | 单个视频转码超时 |

### Nginx 视频流配置

服务端已经返回 `X-Accel-Buffering: no`，仍建议在 Nginx 中显式关闭媒体接口代理缓冲：

```nginx
location /api/files/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
}
```

### 静态资源更新

`public/` 下的 HTML、JS、CSS 统一返回 `Cache-Control: no-cache, must-revalidate`，
并用文件内容的 SHA-1 生成强 ETag。浏览器每次使用缓存前都会向服务器确认：

- 文件没变：返回 304，不重复下载。
- 部署了新文件并重启：ETag 改变，浏览器自动获取新版，不需要用户手动清除缓存。

`index.html` 里还通过 `?v=1.6.1` 引用前端资源。发布新版本时请同步更新
`package.json`、`public/app.js` 的 `APP_VERSION` 和这三个查询串；这样即使旧浏览器
仍缓存着上一版脚本，也会因为 URL 变化立刻请求新文件。

### 重复文件规则

- 每个用户上传时都会计算文件内容的 **SHA-256**，同一用户下内容完全相同的文件只保留一份。
- **改名不能绕过去重**：文件名不同但内容相同，仍会返回 409 `DUPLICATE_FILE`。
- **回收站也算重复**：如果相同文件还在回收站，会提示先去恢复或彻底删除，避免再次占用空间。
- 老记录没有内容哈希时，不会在启动时扫描所有文件；只会在遇到同大小上传时懒计算并回填，避免拖慢服务启动。
- 内容哈希不通过列表接口暴露给浏览器，只用于服务端去重。

### 分类规则

- **MP3 永远是音乐**：上传分类由服务端根据 MIME / 扩展名判断，不读取当前浏览的“文件”“音乐”等筛选状态。
- **筛选只影响显示**：切换左侧分类只改变列表查询条件，不会改变之后上传文件的分类。
- **历史数据自动修复**：升级后首次启动会一次性修正旧版本中误归为“文件”的照片、视频和音乐；之后通过接口手动调整的分类会被保留。

---

## 部署形态

前端是纯静态资源（无构建步骤），后端是一组 JSON 接口，两者通过 `/api/**` 通信。
因此支持两种部署形态，**默认即一体部署，不配置任何环境变量即可运行**。

### 形态一：一体部署（默认）

同一进程、同一端口同时提供前端与接口，天然同源，无 CORS。

```bash
node server.js
# → http://localhost:8787
```

### 形态二：分离部署

前端交给静态托管 / CDN，后端单独跑。需要三步：

**1. 后端声明允许的前端源**

```bash
ALLOWED_ORIGINS=https://vault.example.com,https://vault-staging.example.com \
SERVE_STATIC=0 \
PORT=8787 node server.js
```

| 环境变量 | 作用 |
|---|---|
| `ALLOWED_ORIGINS` | 允许跨域访问的前端源，逗号分隔。**设置后自动切换到分离部署模式** |
| `SERVE_STATIC` | 设为 `0` 则不再托管 `public/`，本进程退化为纯 API 服务 |
| `PORT` | 监听端口，默认 `8787` |
| `MAX_UPLOAD_BYTES` | 单文件上限，默认 2GB |

> 注册码不在这里 —— 它是站点自己的设置，配在 `config.json` 里，见下文「注册控制：注册码」。

**2. 前端指向后端**

编辑 `public/config.js`：

```js
window.VAULT_CONFIG = { apiBase: 'https://api.example.com' }
```

留空字符串即表示同源。页面启用了严格 CSP，不再支持在 `index.html` 里写内联脚本覆盖配置。

**3. 必须部署在 HTTPS 下**

跨站的会话 Cookie 需要 `SameSite=None; Secure` 同时成立，浏览器只在 HTTPS
（以及 `localhost` / `127.0.0.1` 这类可信来源）下接受 `Secure` Cookie。
纯 HTTP 的跨域部署会「登录接口返回 200 但立刻掉线」。

### 两种形态的行为差异

| | 一体部署 | 分离部署 |
|---|---|---|
| CORS 响应头 | 不发送 | 仅对白名单来源回显，带 `Allow-Credentials: true` |
| 会话 Cookie | `SameSite=Lax` | `SameSite=None; Secure` |
| 预检 `OPTIONS` | 不参与 | 白名单来源返回 204，其余 403 |
| 来源校验 | 同源放行 | 同源 + 白名单放行，其余 403 |
| 协议要求 | HTTP 即可 | **必须 HTTPS** |

> 来源校验对所有 `/api/**` 请求生效：只要带 `Origin` 头且不在同源或白名单内，直接 403。
> 这不只是 CORS 礼貌，也是 Cookie 放宽到 `SameSite=None` 之后的 CSRF 兜底。

> 如果由本服务托管 `index.html`，但 `apiBase` 指向另一个域名，需要同步调整
> `lib/static.js` 的 `HTML_CSP.connect-src`，把这个 API 域名加入白名单；
> 前端完全由 CDN / 独立静态服务器托管时，则由那台服务器设置 CSP。

---

## 部署到服务器需要哪些文件

### 必须上传（缺一不可）

```
server.js               入口
package.json            提供 "type": "module"，见下方说明
config.example.json     配置模板（真实配置 config.json 首次启动自动生成）
lib/                    11 个文件：config cors db paths media rate-limit store auth api static video-preview
public/                 5 个文件：index.html app.js styles.css config.js favicon.svg
```

一共 20 个文件（另含 `scripts/optimize-video-previews.mjs`）。项目**零第三方依赖，不需要 `npm install`，也没有 `node_modules`**。
SQLite 用的是 Node 22 内置的 `node:sqlite`，同样不需要装任何东西。

> **Node 版本要求提高到 ≥ 22.5**（`node:sqlite` 从这个版本开始提供）。
> 建议直接用 Node 22 LTS 或更高。Node 18 / 20 跑不起来。

> **`package.json` 不能省。** 它的作用不只是元信息，而是里面的 `"type": "module"`——
> 少了它，Node 会把 `.js` 当 CommonJS，`import` 直接报
> `SyntaxError: Cannot use import statement outside a module`。
> Node 22+ 靠语法自动检测能侥幸跑起来，但 Node 18 / 20 一定会挂。
> 别赌服务器的 Node 版本，老老实实传上去。

### 不要上传

| 文件 | 原因 |
|---|---|
| `data/` | 运行时数据，首次启动自动创建。**传上去等于把已有用户的账号和文件带上生产环境** |
| `.gitignore` | 与运行无关 |
| `README.md` | 文档，传不传都行 |

唯一例外：**迁移已有数据**时才需要把 `data/` 一起带上，此时 `data/secret.key` 必须保留，
否则签名密钥变了，所有已登录用户会被强制登出。

### 前端走 CDN 时（分离部署）

服务器上只放 4 项，完全不需要 `public/`：

```
server.js  package.json  lib/
```

```bash
SERVE_STATIC=0 ALLOWED_ORIGINS=https://vault.example.com PORT=8787 node server.js
```

`public/` 那 5 个文件传到静态托管，并把 `public/config.js` 的 `apiBase` 改成后端地址。
注意跨域必须走 HTTPS，原因见上文「两种形态的行为差异」。

### 启动前检查

| 项 | 要求 |
|---|---|
| Node 版本 | ≥ 22.5（`node:sqlite` 需要）；建议 22 LTS 或 24 LTS |
| 监听地址 | 已绑定 `0.0.0.0`，容器 / 云主机无需改动 |
| 端口 | 读 `PORT` 环境变量，默认 `8787` |
| 目录权限 | 运行账户需对项目目录**可写**（`data/` 要落盘） |
| 常驻运行 | 用 `systemd` / `pm2` / `docker` 托管，别用前台 `node server.js` 跑生产 |

一个最小可用的 systemd 单元：

```ini
[Unit]
Description=Personal Vault
After=network.target

[Service]
WorkingDirectory=/opt/personal-vault
ExecStart=/usr/bin/node server.js
Environment=PORT=8787
Environment=NODE_ENV=production
Restart=always
User=vault

[Install]
WantedBy=multi-user.target
```

---

## 目录结构

```
server.js             HTTP 服务入口（单端口，绑定 0.0.0.0）
lib/config.js         部署配置：跨域白名单、Cookie 策略、容量限额
lib/cors.js           CORS 响应头与预检处理
lib/paths.js          路径常量（单独一层，避免模块循环依赖）
lib/media.js          MIME 补全、分类与安全内联类型判断
lib/rate-limit.js     登录 / 注册 / 上传等敏感接口的内存限流
lib/video-preview.js  可选的低码率 fast-start 视频播放副本生成
lib/db.js             SQLite 连接、建表、内容哈希索引、旧数据迁移
lib/store.js          数据访问层（所有 SQL 都集中在这里）
lib/auth.js           scrypt 密码哈希、HMAC 会话令牌、Cookie 构造
lib/api.js            业务接口：认证、上传、下载、列表、删除
lib/static.js         静态资源、CSP、ETag 与目录穿越防护
public/config.js      前端部署配置（apiBase）
public/index.html     前端页面结构
public/app.js         前端逻辑（所有请求统一经 apiUrl() 拼地址）
public/styles.css     样式与响应式规则
config.json           站点配置（注册码），首次启动自动生成，不入 Git
config.example.json   配置模板（入 Git）
data/vault.db         SQLite 数据库（账号 + 文件索引 + SHA-256 去重指纹）
data/uploads/         文件本体，按用户分文件夹
data/previews/        视频低码率播放副本，不修改原文件
data/secret.key       会话签名密钥
```

---

## 数据存储：为什么用 SQLite

早期版本把所有记录塞进 `files.json`，每次改动都「整个数组重写一遍」。
实测 10 万条记录时，一次写入要序列化 34MB、**阻塞主线程 135ms** ——
这期间整个网站没有任何响应。数据越多越慢，典型症状就是「用一段时间后越来越卡，最后崩」。

现在改用 SQLite（Node 22 内置的 `node:sqlite`，**无需 npm install、无需编译原生模块**）：

| 操作 | JSON 全量重写 | SQLite | 说明 |
|---|---:|---:|---|
| 写入一条记录（10 万条规模） | 135 ms | **0.070 ms** | 只改受影响的那一行 |
| 查询一页 60 条 | 全表读入内存 | **0.094 ms** | 走 `owner_id + created_at` 索引 |
| 内存占用 | 全表常驻 | 按需读页 | 不随文件总数增长 |

约 **1900 倍**的写入提升，而且从「随数据量增长」变成了「基本恒定」。

### 关键配置

- `PRAGMA journal_mode = WAL` —— 读写可以并发，不会互相锁住
- `PRAGMA foreign_keys = ON` —— 删用户时级联删掉他的文件记录（**SQLite 默认不检查外键**，必须手动开）
- `PRAGMA busy_timeout = 5000` —— 锁冲突时等 5 秒而不是立刻报错
- 两个组合索引：`(owner_id, created_at DESC)` 和 `(owner_id, category, created_at DESC)`

### 从旧版 JSON 自动迁移

首次启动时，如果检测到数据库是空的、且存在 `data/users.json` / `data/files.json`，
会自动导入全部账号和文件记录（在一个事务里，要么全成功要么全回滚），
然后把旧文件改名为 `*.json.migrated` 留作备份。

启动日志会明确告诉你迁移了多少：

```
数据迁移：已从 JSON 导入 1 个用户、3 条文件记录
         旧文件已备份为 data/*.json.migrated
```

确认新版本运行正常后，可以手动删掉 `.migrated` 文件。

### 备份

停止服务后直接拷贝 **`data/vault.db`** 即可（连同 `data/uploads/`）。

如果服务在运行，还要一并拷 `vault.db-wal`（WAL 模式下最新写入可能还在这个文件里）。
更稳妥的做法是用 SQLite 自带的在线备份：

```bash
sqlite3 data/vault.db ".backup 'backup.db'"
```

### 回收站机制

删除不是真删，只给记录打一个 `deleted_at` 时间戳：

- 列表查询一律带 `deleted_at IS NULL` 条件，所以删除后立刻从列表消失
- 数据库行和磁盘文件都保留，24 小时内可以从回收站恢复
- 超过 24 小时由定时任务真正清除：删磁盘文件 + 删记录

定时任务每 10 分钟扫描一次，进程启动时也会先扫一次。
所以最坏情况是晚 10 分钟清理，用户完全感知不到。

**容量计算包含回收站内容。** `totalBytesFor()` 不区分是否已删除，
因为回收站里的文件仍然占着磁盘 —— 否则用户可以靠「删了再传」绕过配额。
侧栏总用量包含正常文件与回收站文件，并单独显示回收站占用，避免“删进回收站后空间看似消失”的误解。

老数据库升级时会自动补 `deleted_at` 列（先 `PRAGMA table_info` 检查再 `ALTER TABLE`），
重复启动也不会报错，不需要手工迁移。

---

## 代码导读：一次请求的完整旅程

如果没写过 Node.js，建议按这个顺序读代码。不需要懂框架，只需要跟着「一次点击」走一遍。

### 第 0 步：先建立三个心智模型

**① 服务器 = 一台一直开着的程序**

`node server.js` 执行后，程序不会结束，而是停在 `server.listen()` 那一行等别人来访问。
普通脚本跑完就退出，服务器脚本跑完不退出 —— 这是最根本的区别。

Node.js 则是「把浏览器里的 JavaScript 引擎搬到电脑上」，因此 JS 既能写网页，
也能读写文件、监听网络端口。所以这个项目前后端都是 JS。

**② HTTP 是「无记忆」的**

每个请求都是独立的，服务器天生不知道这次和上次是不是同一个人。
所以登录后要发一张凭证（Cookie），之后每次请求都带着它 ——
这就是为什么所有登录逻辑最终都围绕 Cookie 转。

**③ 前端只管画，后端只管给数据**

后端从不说「这个按钮该长什么样」，它只回 JSON。
页面长什么样全由前端根据数据决定。两者唯一的桥梁是 `/api/**` 接口。

### 第 1 步：访问首页

```
浏览器: GET /
   → server.js 收到请求，判断不是 /api/ 开头
   → lib/static.js 读 public/index.html 返回
浏览器: 解析 HTML，发现引用了 styles.css、config.js、app.js
   → 自动再发 3 个请求把它们取回来
浏览器: 执行 app.js
```

`lib/static.js` 里有两个值得留意的地方：
**防目录穿越**（不检查的话，请求 `/../lib/auth.js` 就能下载到后端源码）
和**流式发送**（`createReadStream().pipe(res)`，传 2GB 视频也不占内存）。

### 第 2 步：app.js 启动，判断登录状态

```js
boot()                      // public/app.js 最后一行
  ├─ bindAuth() / bindApp() // 先挂好所有按钮的监听器
  └─ api('/api/auth/me')    // 问服务器「我是谁」
       ├─ 有有效 Cookie → 返回用户信息 → showApp() → refresh()
       └─ 没有          → 401，api() 抛异常 → showAuth() 显示登录页
```

`api()` 是前端所有请求的统一入口，里面 `credentials: 'include'`
是让浏览器带上 Cookie 的关键 —— 少了它，所有需要登录的接口都会返回 401。

### 第 3 步：登录时发生了什么

```
前端  POST /api/auth/login  { email, password }
  → lib/api.js  handleLogin()
      找用户 → lib/auth.js verifyPassword() 用 scrypt 重算哈希比对
      成功 → signToken() 签发令牌
           → 通过 Set-Cookie 发给浏览器
浏览器: 存下 Cookie（HttpOnly，JS 读不到，防 XSS 偷取）
```

令牌长这样：`数据部分.签名`。数据部分是明文的（装着用户 id 和过期时间），
关键在签名 —— 用服务器私有密钥算出来的，别人没有密钥就伪造不出合法令牌。
**它不是加密，只是防篡改**，所以别往里面放密码。

服务端不保存「谁在线」的名单（这叫无状态），靠签名保证真实性。
好处是重启服务不影响已登录用户。

### 第 4 步：上传一个文件

```
前端  用 XMLHttpRequest 而不是 fetch（因为要进度条）
      POST /api/files/upload?name=照片.png
      请求体 = 文件的原始二进制内容，没有任何表单包装
  → lib/api.js handleUpload()
      磁盘名 = 随机UUID + 安全扩展名（绝不使用用户给的文件名，防路径穿越）
      用 pipeline 边接收边写盘，内存占用恒定
      超限立刻中断并删掉半个文件
      调用 lib/media.js 自动判断分类（MP3 → 音乐）
      写入数据库记录，其中 ownerId 由服务端填写 ← 前端伪造不了
```

用 `XMLHttpRequest` 而非 `fetch` 的原因很实际：`fetch` 直到传完才给结果，
中间没有进度回调；XHR 有 `upload.onprogress`。

### 第 5 步：数据隔离是怎么做到的

这是全项目最关键的安全设计，靠两条规则：

1. **每条记录带 `ownerId`**，上传时由服务端写入，前端传什么都不算数
2. **所有查询先按当前用户过滤**，别人的记录一律当作「不存在」

对应 `lib/api.js` 里的 `findOwnedFile()`：

```js
const record = fileStore.all().find((row) => row.id === id)
if (!record) return null                 // 确实不存在
if (record.ownerId !== ownerId) return null   // 是别人的 → 也当作不存在
```

注意第二种情况返回的也是 404，而不是 403「禁止访问」。
因为 403 等于告诉对方「这个文件存在，只是不给你看」——
攻击者能借此探测出别人有哪些文件。统一成 404 就什么都问不出来。

**安全性由服务端保证，绝不依赖前端「不显示按钮」。**

### 第 6 步：为什么视频能拖进度条

浏览器看视频时不会等整个文件下完，它会发 `Range: bytes=1000000-2000000`，
只要这一段。服务器回 206 而不是 200，只发指定区间。
`lib/api.js` 的 `sendStoredFile()` 就是在处理这个。

### 第 7 步：图片为什么要“限边界 + 变速平移”

图片灯箱的状态集中在 `public/app.js` 的 `zoom` 对象里：

- `scale` 是缩放倍率，`1` 表示完整适配预览区，范围是 `0.5x–8x`。
- `x / y` 是平移量，但会被 `clampZoomPan()` 限制在图片边界内，避免拖到完全看不见。
- 平移边界按 `object-fit: contain` 后**真正画出来的图片尺寸**计算，而不是按元素盒子的宽高计算。
- `panFactorForScale()` 会随倍率提高拖动速度，最高为 `3x`；因此 800% 时不必在狭小的预览区里反复拖动很多次。

视频不参与缩放，直接铺满预览区并使用 `object-fit: contain` 完整显示；图片和视频所在灯箱都会关闭滚动条，避免媒体溢出。

### 读代码的推荐顺序

| 顺序 | 文件 | 看点 |
|---|---|---|
| 1 | `server.js` | 请求进来后如何分流 |
| 2 | `lib/static.js` | 前端文件怎么发出去 |
| 3 | `lib/db.js` | 建表、索引、WAL、旧数据迁移 |
| 4 | `lib/store.js` | SQL 怎么写、参数化查询、分页 |
| 5 | `lib/auth.js` | 加盐哈希、令牌签名 |
| 6 | `lib/api.js` | 所有业务逻辑 + 数据隔离 |
| 7 | `public/app.js` | 数据怎么变成界面、图片缩放与高倍平移 |

---

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册并登录（需要注册码时带 `registrationCode`） |
| GET | `/api/auth/config` | 注册策略（`{ requireRegistrationCode }`），前端据此决定显不显示注册码输入框 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 当前用户 |
| PATCH | `/api/auth/password` | 修改密码 |
| GET | `/api/files` | 列表（`category` / `q` / `sort` / `limit` / `offset`） |
| POST | `/api/files/upload` | 上传（原始二进制流，`name` 走查询串；自动分类并返回 409 `DUPLICATE_FILE` 拒绝重复内容） |
| GET | `/api/files/:id/raw` | 内联预览（支持 Range） |
| GET | `/api/files/:id/download` | 附件下载 |
| PATCH | `/api/files/:id` | 重命名 / 改分类 |
| DELETE | `/api/files/:id` | 移入回收站（软删除，24 小时内可恢复） |
| POST | `/api/files/:id/restore` | 从回收站恢复 |
| GET | `/api/trash` | 回收站列表（`q` / `limit` / `offset`），返回 `expiresAt` 与 `ttlMs` |
| DELETE | `/api/trash/:id` | 彻底删除单个文件（不可恢复） |
| DELETE | `/api/trash` | 清空回收站 |

列表接口的返回形如：

```json
{
  "files": [ … ],
  "usage": { "total": 71, "bytes": 1048576, "byCategory": { "image": 0, "video": 0, "file": 71 } },
  "page": { "limit": 60, "offset": 0, "total": 71, "hasMore": true }
}
```

`limit` 上限 200，默认 60。前端靠 `page.hasMore` 决定是否显示「加载更多」。

---

## 数据安全说明

- 密码使用 scrypt 加盐哈希存储，新密码限制为 8–128 位，明文永不落盘。
- 会话使用 HMAC-SHA256 签名的 HttpOnly Cookie，30 天有效；签名密钥首次启动生成并保存在 `data/secret.key`，启动时会校验格式。
- 令牌包含会话版本；修改密码会递增版本并撤销其它设备上的旧会话。升级到 1.5.0 及以后旧版本令牌会失效一次，需要重新登录。
- 存储文件名由服务端生成（UUID + 安全扩展名），不直接使用用户原始文件名，杜绝路径穿越。
- 所有文件类接口先校验登录态，再校验记录归属；非本人记录按「不存在」响应，不泄露他人内容的存在性。
- 所有 SQL 都用参数化查询，唯一拼进 SQL 的是排序方式，且取自写死的白名单（防 SQL 注入）。
- 只有安全的图片 / 音频 / 视频类型允许内联预览；HTML、SVG、XML、PDF 等主动内容一律以 `application/octet-stream` 附件下载，防止同源存储型 XSS。
- 页面启用 CSP、`X-Frame-Options`、`nosniff`、Permissions-Policy 和 HTTPS 下的 HSTS。
- 上传体积在上限处即时中断并清理半成品文件；上传长时间无数据会自动断开（默认 60 秒）。
- 登录、注册、改密、普通 API 和上传都有内存限流；单用户最多同时进行 4 个上传，进程总量最多 32 个。
- 前置反向代理时记得传 `X-Forwarded-Proto`，否则同源 HTTPS 部署下 Cookie 不会带 `Secure`。
- 如果前面是 Nginx / Cloudflare，设置 `TRUST_PROXY=1`，限流才会使用真实客户端 IP；前提是代理必须覆盖并清洗 `X-Forwarded-For` / `CF-Connecting-IP`，否则客户端可以伪造 IP 绕过限流。
- 应用层限流不能抵御大流量 DDoS，生产环境仍应在 Cloudflare / Nginx 层配置连接数、请求速率和区域访问策略。
- `data/`、`uploads/` 在支持的平台上会收紧到 `0700`，数据库和签名密钥为 `0600`，避免同机其他系统账号直接读取。

### 安全边界与剩余风险

- **限流是单进程内存限流**：重启会清空计数，多进程部署时各进程独立计数。对外服务应同时在 Cloudflare / Nginx 配置限速。
- **大流量 DDoS 不能只靠 Node 解决**：带宽型攻击、海量分布式 IP 仍需 CDN、WAF、连接数和区域策略。
- **退出登录只清除当前浏览器 Cookie**：无状态令牌在到期前仍可能被已窃取的副本使用；怀疑令牌泄露时应立即修改密码，修改密码会撤销其它旧会话。
- **上传内容不做病毒扫描**：本站只按 MIME / 扩展名选择安全的下载方式，不保证文件本身不含恶意代码；不要公开分享下载链接。
- **开放注册就是安全边界变化**：将 `registrationCode` 设为空等于允许互联网用户注册，应配合更严格的配额和 WAF 策略。
- **系统账号被攻破时应用无法自保**：数据库、签名密钥和上传目录必须依赖服务器本身的操作系统权限与备份安全。

### 容量防护

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `MAX_USER_BYTES` | 10 GB | 单用户可用容量，超出返回 413 `QUOTA_EXCEEDED`；设 `0` 不限制 |
| `MIN_FREE_BYTES` | 1 GB | 磁盘保留余量，剩余低于此值返回 507 `INSUFFICIENT_STORAGE` |
| `MAX_UPLOAD_BYTES` | 2 GB | 单文件上限 |
| `UPLOAD_IDLE_TIMEOUT_MS` | 60000 | 上传空闲多久判定连接已死并断开 |
| `MEDIA_RANGE_CHUNK_BYTES` | 32 MB | 单次视频 Range 响应上限，兼顾高延迟网络与连接数量 |

三层把关：**用户配额 → 磁盘余量 → 流式实时计数**。
前两层是为了「快速拒绝并给出好懂的提示」，第三层才是真正的兜底。
以前没有这些限制，40G 磁盘存 20 个 4K 视频就满，写满后数据库写入失败、上传全部报错，
表现就像服务器崩了。

### 注册控制：注册码

注册码配在项目根目录的 **`config.json`** 里，不是环境变量：

```json
{
  "registrationCode": "VAULT-QW2M-A3JW-YHH4"
}
```

| 情况 | 行为 |
|---|---|
| `config.json` 不存在 | **首次启动自动生成**，写入一个随机注册码，并在控制台打印出来 |
| `registrationCode` 有值 | 注册必须填对注册码，否则 403 `INVALID_REGISTRATION_CODE` / `REGISTRATION_CODE_REQUIRED` |
| `registrationCode` 为空字符串 | 开放注册，前端**不显示**注册码输入框 |

首次启动时控制台会这样提示：

```
注册策略：需要注册码才能注册

已生成 config.json，本次注册码：
    VAULT-QW2M-A3JW-YHH4
把它发给要注册的人。想更换就直接改 config.json 里的 registrationCode，重启生效。
```

实现要点：

- **为什么用文件而不是环境变量**：注册码属于「这个站点自己的设置」，
  放在文件里可以直接用编辑器改，看得见、改完重启就生效，也不用记环境变量怎么拼。
- **`config.json` 不进 Git**（已加入 `.gitignore`），仓库里只放 `config.example.json` 模板。
- **不预置任何默认值**。首次启动随机生成，避免出现「大家都忘了改 123456」这种等于没防护的情况。
- **解析失败直接报错退出**，而不是「当作没配置」。后者会让一个格式错的文件静默变成开放注册。
- 校验时**忽略首尾空格和大小写**，因为注册码是要发给别人手输的，卡大小写很影响体验。
- 校验发生在「邮箱格式检查之后、邮箱查重之前」。这个位置是有意的：
  放在查重之后，没有注册码的人就能靠「邮箱已注册」这个提示批量探测哪些邮箱注册过本站。
- 前端通过 `GET /api/auth/config` 拿一个布尔值来决定显不显示输入框，
  **服务端从不把注册码本身下发给前端**。
- 已有的老账号密码不变，可以照常登录；升级到 1.5.0 及以后旧会话令牌会失效一次。

> 注册接口现在限制同一来源每小时最多 10 次注册请求，但注册码仍应使用随机值。
> 自动生成的码是 12 位（约 2^60 种组合），足够安全；**手动改的话别用 `123456` 这种**。

## 改造时容易漏的点

分离部署后，**图片和视频不是走 `fetch` 的**，而是由浏览器按 URL 直接加载。
这类地址必须同样经过 `apiUrl()` 拼接，否则会出现「列表正常、缩略图全裂」：

- `cardHtml()` 里的 `<img src>` / `<video src>`（`/raw`）
- `cardHtml()` 和 `openLightbox()` 里的下载链接（`/download`）

新增任何「用标签加载后端资源」的地方，都要检查这一点。

## 后续可扩展

- 分享链接、文件夹层级、缩略图生成、回收站、断点续传。
- 如需跨设备云端持久化与多端同步，可将 `lib/store.js` 与上传目录替换为对象存储 + 云端数据库实现。
