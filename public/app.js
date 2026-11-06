/* ══════════════════════════════════════════════════════════════════════════
   public/app.js —— 前端逻辑（在浏览器里运行的 JavaScript）
   ══════════════════════════════════════════════════════════════════════════

   【这个文件和后端是什么关系】

     后端（server.js + lib/）在服务器上跑，负责存数据、验证身份、管文件。
     前端（本文件）在用户的浏览器里跑，负责把界面画出来、响应用户操作。

     两者唯一的沟通方式是「接口」：前端用 fetch() 发 HTTP 请求，
     后端返回 JSON 数据。前端拿到数据后自己拼 HTML 显示出来。
     服务器从不参与「画页面」，它只给数据。

     举例 —— 用户点「照片」分类时发生的事：
       1. 本文件把 state.category 改成 'image'
       2. 调 api('/api/files?category=image') 发请求
       3. 后端从 SQLite 中按 owner_id 和分类查询该用户的照片，返回 JSON
       4. 本文件拿到数据，重新渲染整个网格

   【为什么页面不用刷新就能变】
     这叫做「单页应用」（SPA）：index.html 只加载一次，
     之后所有变化都由 JS 直接改 DOM 完成，不再向服务器要新页面。
     页面地址栏不变，但内容一直在换。

   【读代码前需要知道的 3 个概念】

     1. document / DOM
        document 代表整个页面。$('#file-grid') 就是「找到 id 为 file-grid 的元素」。
        本文件大量使用「改 DOM」的方式更新界面。

     2. async / await + fetch
        fetch() 是浏览器自带的发请求函数。它返回的不是数据本身，
        而是一个「将来会有结果的凭据」，所以要配合 await 才能拿到真正的数据。

     3. 事件监听 addEventListener
        「等用户做了什么，就调用这个函数」。例如点击、输入、拖拽。
        文件最后的 boot() 就是给各个按钮挂上监听器的过程。

   【整体结构】按下面的分节标题顺序阅读即可
     通用工具 → Toast 提示 → 拖拽状态 / 隐私解锁 → 认证 → 文件夹与列表渲染
     → 数据加载 → 上传 → 图片缩放 → 音乐播放器 → 视频与灯箱
     → 文件与文件夹操作 → 事件绑定 → 启动
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * $ 和 $$ 是两个简写工具。
 *   $  = 找一个元素        $('#upload-btn')
 *   $$ = 找一堆元素，返回数组  $$('.card')
 * 等价于原生的 querySelector / querySelectorAll，只是写起来短一些。
 */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

const CATEGORY_LABEL = { all: '全部', image: '照片', video: '视频', music: '音乐', file: '文件' }

/**
 * 后端地址。默认空串 = 与页面同源（一体部署）。
 * 分离部署时由 config.js 填写，例如 'https://api.example.com'。
 * 注意：图片 / 视频是用标签直接加载的，不走 fetch，所以必须统一用 apiUrl() 拼地址。
 */
const API_BASE = String((window.VAULT_CONFIG && window.VAULT_CONFIG.apiBase) || '').replace(/\/+$/, '')
const apiUrl = (path) => `${API_BASE}${path}`

const DEFAULT_ICP_URL = 'https://beian.miit.gov.cn/'

/** 只允许 HTTP(S) 备案查询地址，非法配置回退到工信部官方入口。 */
function resolveIcpUrl(value) {
  try {
    const parsed = new URL(String(value || DEFAULT_ICP_URL), window.location.href)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : DEFAULT_ICP_URL
  } catch {
    return DEFAULT_ICP_URL
  }
}

/** 根据 public/config.js 的 icp 配置显示或隐藏全站备案页脚。 */
function applySiteFooter() {
  const footer = $('#site-footer')
  const link = $('#icp-link')
  if (!footer || !link) return

  const icp = (window.VAULT_CONFIG && window.VAULT_CONFIG.icp) || {}
  const number = String(icp.number || '').trim()
  const enabled = icp.enabled === true && Boolean(number)

  document.body.classList.toggle('has-site-footer', enabled)
  footer.hidden = !enabled
  if (!enabled) return

  link.href = resolveIcpUrl(icp.url)
  link.textContent = number
  link.setAttribute('aria-label', `查看 ${number} 备案信息`)
}

/**
 * 整个界面的「状态」。可以理解为这一屏界面上所有会变的东西都记在这里。
 *
 * 为什么不直接把数据塞进 DOM 里，而要单独存一份？
 *   因为 DOM 是「结果」，状态是「原因」。
 *   要重新渲染时，只要读这个对象就能画出一致的界面 ——
 *   例如切换分类时，我们知道当前是哪个分类、搜索词是什么，才能拼出正确的请求参数。
 */
const state = {
  user: null,        // 当前登录用户，null 表示没登录
  files: [],         // 当前「已加载」的文件（可能只是第一页）
  folders: [],       // 当前目录下的文件夹
  folderId: null,    // 当前所在文件夹；null 表示根目录
  currentFolder: null, // 当前文件夹对象；null 表示根目录
  breadcrumbs: [],   // 根目录到当前文件夹的路径
  usage: null,       // 当前视图的用量统计；隐私视图使用独立统计
  category: 'all',   // 当前选中的分类
  query: '',         // 搜索关键词
  sort: 'newest',    // 排序方式
  lightboxId: null,  // 灯箱里正在看哪个文件
  lightboxNavigating: false, // 是否正在为灯箱加载下一页
  total: 0,          // 当前筛选条件下共有多少条（由服务器告知）
  page: 1,           // 当前页码，从 1 开始
  pageCount: 1,      // 当前筛选条件下的总页数
  hasMore: false,    // 是否还有下一页
  loadingMore: false, // 是否正在加载或切换页面
  requireRegistrationCode: false, // 服务端是否要求注册码（决定要不要显示那个输入框）
  trash: false,      // 是否处于回收站视图
  ttlMs: 24 * 60 * 60 * 1000, // 回收站保留时长（由服务器下发，前端只用来算倒计时）
  videoQuality: '720p', // 视频播放清晰度：720p / original
  privacyMode: false,
  privacyUnlocked: false,
  transferMode: false, // 是否正在查看独立的传输任务页面
  viewMode: 'grid',   // 文件视图：grid 网格 / list 列表
}

/**
 * 传输模块需要的宿主能力。
 *
 * transfers.js 独立加载，只通过这个对象访问主脚本的状态和公共函数；这样上传、
 * 下载队列不会继续膨胀 app.js，同时仍能复用登录、隐私解锁、刷新和提示逻辑。
 */
window.VaultTransferHost = {
  state,
  api,
  apiUrl,
  $,
  $$,
  escapeHtml,
  formatSize,
  fileSignature,
  uniqueFiles,
  notify,
  refresh,
  showAuth,
  requestPrivacyUnlock,
  updatePrivacyIndicator,
  notePrivacyActivity,
  renderGrid,
  renderPagination,
}

/**
 * 每页加载多少条。
 *
 * 【为什么要分页】
 *   之前是一次把全部文件要回来。文件攒到几千个以后，
 *   一次响应几百 KB，浏览器还要一次性建出几千个卡片节点，
 *   页面会明显卡顿。更糟的是每个卡片都会去请求缩略图，
 *   服务器瞬间被打出上百个并发连接，小内存机器直接扛不住。
 *   现在一次只拿 30 条，通过底部分页控件切换页面。
 */
const PAGE_SIZE = 30
let listRequestVersion = 0
const VIDEO_QUALITY_KEY = 'personal-vault:video-quality'
const VIEW_MODE_KEY = 'personal-vault:view-mode'
const PRIVACY_IDLE_MS = 10 * 60 * 1000
const PRIVACY_HEARTBEAT_MS = 4 * 60 * 1000
let privacyIdleTimer = 0
let privacyAuthResolver = null
let privacyAuthMode = 'unlock'
let privacyHeartbeatAt = 0
let privacyHeartbeatPromise = null
let privacyReloadLockPromise = null
try {
  const savedQuality = localStorage.getItem(VIDEO_QUALITY_KEY)
  if (['720p', 'original'].includes(savedQuality)) state.videoQuality = savedQuality
  const savedViewMode = localStorage.getItem(VIEW_MODE_KEY)
  if (['grid', 'list'].includes(savedViewMode)) state.viewMode = savedViewMode
} catch { /* 隐私模式可能禁用 localStorage */ }

/* ───────────────────────────── 通用工具 ───────────────────────────── */

function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

function formatDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const now = Date.now()
  const diff = now - date.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

function extOf(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''))
  return match ? match[1].toUpperCase() : 'FILE'
}

/**
 * 向后端发请求的统一入口。所有和服务器打交道的地方都走这个函数。
 *
 * @param {string} path    接口路径，例如 '/api/files?sort=newest'
 * @param {object} options 额外配置，例如 { method: 'POST', body: '...' }
 * @returns {Promise<object>} 后端返回的 JSON 数据
 */
/**
 * 页面内部卡片拖拽状态。
 *
 * 卡片拖拽用于移动文件 / 文件夹，而桌面文件拖入用于上传。部分浏览器会把页面内
 * 图片拖拽也暴露成 'Files'，仅凭 dataTransfer.types 无法可靠区分；因此卡片拖拽
 * 会额外携带 CARD_DRAG_MIME 并设置 internalDragActive，直到 dragend / drop 才解除。
 * 这两层标记共同避免拖动缩略图时误触发一次重复上传。
 */
const CARD_DRAG_MIME = 'application/x-personal-vault-item'
let internalDragActive = false
let internalDragResetTimer = 0

function markInternalDragStart() {
  internalDragActive = true
  clearTimeout(internalDragResetTimer)
  // 兜底：某些浏览器拖拽取消时不会触发 dragend，不能让标记永久卡住
  internalDragResetTimer = setTimeout(() => {
    internalDragActive = false
  }, 10_000)
}

function markInternalDragEnd() {
  clearTimeout(internalDragResetTimer)
  // 等当前 drop 事件处理完再解除，避免事件顺序不同造成误判
  internalDragResetTimer = setTimeout(() => {
    internalDragActive = false
  }, 0)
}

/**
 * 判断这次拖拽是不是「从系统里拖文件进来」。
 *
 * 页面内部 dragstart 会先设置 internalDragActive，所以即使浏览器给内部拖拽
 * 伪造了 Files，也不会被当成上传。text/html / text/uri-list 继续作为第二道判断。
 */
function isExternalFileDrag(dataTransfer) {
  if (internalDragActive || !dataTransfer) return false
  const types = Array.from(dataTransfer.types || [])
  if (!types.includes('Files')) return false
  return !types.includes('text/html') && !types.includes('text/uri-list')
}

/** 同一个文件在一次拖拽 / 选择里的稳定指纹。 */
function fileSignature(file) {
  return JSON.stringify([file.name, file.size, file.lastModified || 0, file.type || ''])
}

/** 合并同一次操作中重复出现的 File，避免一次拖拽生成多条上传请求。 */
function uniqueFiles(fileList) {
  const seen = new Set()
  return Array.from(fileList || []).filter((file) => {
    const key = fileSignature(file)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 前端自身的版本号。
 *
 * 【为什么要显示它】
 *   这个项目是「拷文件部署」的，很容易出现服务器跑着旧代码、
 *   而你以为新功能已经生效的情况。把版本号显示在页面上，
 *   一眼就能判断「我看到的这版到底是哪一版」——
 *   如果页面上没有新功能、版本号却已经是新的，说明后端没更新；
 *   如果版本号是旧的，说明前端没更新。
 *
 * 改动前端功能时记得同步这里和 package.json。
 */

/**
 * 调用后端 JSON API，并把非 2xx 响应转换为异常。
 *
 * @param {string} path 以 /api/ 开头的相对路径
 * @param {RequestInit} options fetch 选项；默认 credentials=include
 * @returns {Promise<any>} 解析后的 JSON；空响应或非 JSON 成功响应返回 null
 * @throws {Error & {status?: number, code?: string}} HTTP 非 2xx 时抛出
 */
async function api(path, options = {}) {
  const { timeoutMs = 30_000, signal, ...fetchOptions } = options
  const controller = signal ? null : new AbortController()
  const effectiveSignal = signal || controller.signal
  let timedOut = false
  const timer = controller && timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true
      controller?.abort()
    }, timeoutMs)
    : 0

  try {
    const res = await fetch(apiUrl(path), {
      credentials: 'include',
      ...fetchOptions,
      signal: effectiveSignal,
    })

    let body = null
    try {
      body = await res.json()
    } catch {
      /* 非 JSON 响应 */
    }

    if (!res.ok) {
      const error = new Error((body && body.error) || `请求失败（${res.status}）`)
      error.status = res.status
      error.code = body && body.code
      throw error
    }
    return body
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const abortError = new Error(timedOut ? '请求超时，请稍后重试' : '请求已取消')
      abortError.code = timedOut ? 'REQUEST_TIMEOUT' : 'ABORTED'
      throw abortError
    }
    if (error && !error.status && error.name === 'TypeError') {
      const networkError = new Error('网络连接失败，请检查连接后重试')
      networkError.code = 'NETWORK_ERROR'
      throw networkError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/* ───────────────────────────── Toast ───────────────────────────── */

function createToast({ title, sub = '', kind = '' }) {
  const el = document.createElement('div')
  el.className = `toast${kind ? ` is-${kind}` : ''}`
  el.innerHTML = `
    <div class="toast-head"><span class="dot"></span><span class="toast-name"></span></div>
    ${sub ? '<div class="toast-sub"></div>' : ''}
    <div class="toast-track"><i></i></div>`
  const nameEl = $('.toast-name', el)
  nameEl.textContent = title
  nameEl.title = title
  const subEl = $('.toast-sub', el)
  if (subEl) subEl.textContent = sub
  $('#toasts').appendChild(el)

  return {
    el,
    progress(ratio) {
      const bar = $('.toast-track i', el)
      if (bar) bar.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`
    },
    setSub(text) {
      const node = $('.toast-sub', el)
      if (node) node.textContent = text
    },
    succeed(text) {
      el.classList.add('is-ok')
      this.progress(1)
      if (text !== undefined) this.setSub(text)
      setTimeout(() => el.remove(), 2600)
    },
    fail(text) {
      el.classList.add('is-error')
      this.setSub(text)
      setTimeout(() => el.remove(), 5200)
    },
  }
}

function notify(message, kind = 'error') {
  const toast = createToast({ title: message, kind })
  if (kind !== 'error') {
    setTimeout(() => toast.el.remove(), 2600)
  } else {
    toast.progress(1)
    setTimeout(() => toast.el.remove(), 4600)
  }
}

/* ───────────────────────────── 视图切换 ───────────────────────────── */

/**
 * 切换到「未登录」界面：显示登录/注册页，隐藏主界面。
 * 同时清掉内存里的用户数据，并关掉可能开着的弹窗。
 */
function showAuth() {
  if (window.VaultTransfers) window.VaultTransfers.pauseForAuth()
  resetPrivacyState()
  state.user = null
  state.transferMode = false
  state.files = []
  state.folders = []
  state.folderId = null
  state.currentFolder = null
  state.breadcrumbs = []
  clearPreviewPreloads()
  // 分页状态也要重置，否则换账号登录后会接着上一个人的「已加载数量」往下取
  state.total = 0
  state.page = 1
  state.pageCount = 1
  state.hasMore = false
  state.loadingMore = false
  state.trash = false
  $('#app-view').hidden = true
  $('#auth-view').hidden = false
  $('#pagination').hidden = true
  closeLightbox()
  $('#password-modal').hidden = true
}

function updatePrivacyIndicator() {
  const label = $('#privacy-state')
  if (!label) return
  if (!state.user) label.textContent = '锁定'
  else if (!state.user.hasPrivacyPassword) label.textContent = '未设置'
  else if (state.privacyUnlocked) label.textContent = '已解锁'
  else label.textContent = '锁定'
}

function clearPrivacyIdleTimer() {
  clearTimeout(privacyIdleTimer)
  privacyIdleTimer = 0
}

function closePrivacyAuthDialog(success = false) {
  const modal = $('#privacy-modal')
  const form = $('#privacy-form')
  if (modal) modal.hidden = true
  if (form) form.reset()
  if (privacyAuthResolver) {
    const resolve = privacyAuthResolver
    privacyAuthResolver = null
    resolve(Boolean(success))
  }
}

function resetPrivacyState() {
  clearPrivacyIdleTimer()
  state.privacyMode = false
  state.privacyUnlocked = false
  privacyHeartbeatAt = 0
  closePrivacyAuthDialog(false)
  updatePrivacyIndicator()
  window.VaultTransfers?.render()
}

function focusPrivacyAuthField() {
  const form = $('#privacy-form')
  const input = privacyAuthMode === 'reset' ? form.elements.accountPassword : form.elements.password
  setTimeout(() => input.focus(), 0)
}

/** 在设置、解锁和重置三种表单状态之间切换。 */
function applyPrivacyAuthMode(mode, { focus = true } = {}) {
  privacyAuthMode = ['setup', 'unlock', 'reset'].includes(mode) ? mode : 'unlock'
  const form = $('#privacy-form')
  const setup = privacyAuthMode === 'setup'
  const reset = privacyAuthMode === 'reset'
  const needsConfirm = setup || reset
  const accountField = $('#privacy-account-field')
  const confirmField = $('#privacy-confirm-field')
  const passwordInput = form.elements.password
  const accountInput = form.elements.accountPassword
  const links = $('.privacy-links', form)
  const errorBox = $('[data-error]', form)

  errorBox.hidden = true
  accountField.hidden = !reset
  accountInput.required = reset
  $('#privacy-password-label').textContent = reset ? '新隐私密码' : '隐私密码'
  confirmField.hidden = !needsConfirm
  form.elements.confirmPassword.required = needsConfirm
  passwordInput.minLength = needsConfirm ? 8 : 1
  passwordInput.autocomplete = needsConfirm ? 'new-password' : 'current-password'
  $('#privacy-reset-link').hidden = privacyAuthMode !== 'unlock'
  $('#privacy-back').hidden = !reset
  links.hidden = !(privacyAuthMode === 'unlock' || reset)

  if (setup) {
    $('#privacy-title').textContent = '设置隐私密码'
    $('#privacy-desc').textContent = '首次使用需要设置独立的隐私密码。设置后，访问隐私文件必须再次验证。'
    $('#privacy-hint').textContent = '首次设置至少 8 位。隐私空间用于访问隔离，不会加密磁盘上的原始文件。'
    $('#privacy-submit').textContent = '设置并进入'
  } else if (reset) {
    $('#privacy-title').textContent = '重置隐私密码'
    $('#privacy-desc').textContent = '输入当前账号密码验证身份，然后设置新的隐私密码。已存放的隐私文件不会被删除。'
    $('#privacy-hint').textContent = '新隐私密码至少 8 位。重置后，其它设备上已解锁的隐私空间会立即失效。'
    $('#privacy-submit').textContent = '重置并进入'
  } else {
    $('#privacy-title').textContent = '解锁隐私空间'
    $('#privacy-desc').textContent = '请输入隐私密码以查看隐私空间中的文件。'
    $('#privacy-submit').textContent = '解锁'
  }
  $('#privacy-hint').hidden = !needsConfirm

  if (focus) focusPrivacyAuthField()
}

function openPrivacyAuthDialog() {
  const setup = !state.user || !state.user.hasPrivacyPassword
  const modal = $('#privacy-modal')
  const form = $('#privacy-form')

  form.reset()
  applyPrivacyAuthMode(setup ? 'setup' : 'unlock', { focus: false })
  modal.hidden = false
  focusPrivacyAuthField()

  return new Promise((resolve) => {
    if (privacyAuthResolver) privacyAuthResolver(false)
    privacyAuthResolver = resolve
  })
}

async function requestPrivacyUnlock() {
  // 刷新后的锁定请求可能与主界面并行；任何隐私操作都要先等它落地，
  // 避免旧隐私 Cookie 与新解锁 Cookie 发生覆盖竞态。
  if (privacyReloadLockPromise) await privacyReloadLockPromise
  if (state.privacyUnlocked) return true
  return openPrivacyAuthDialog()
}

/** 提交隐私密码设置、解锁或账号密码验证重置表单。 */
async function submitPrivacyAuth(form) {
  const mode = privacyAuthMode
  const needsConfirm = mode === 'setup' || mode === 'reset'
  const password = form.elements.password.value
  const confirmPassword = form.elements.confirmPassword.value
  const accountPassword = form.elements.accountPassword.value
  const errorBox = $('[data-error]', form)
  const submit = $('#privacy-submit')
  errorBox.hidden = true

  if (needsConfirm && password !== confirmPassword) {
    errorBox.textContent = '两次输入的新隐私密码不一致'
    errorBox.hidden = false
    form.elements.confirmPassword.focus()
    return
  }

  submit.disabled = true
  try {
    const endpoint = mode === 'setup'
      ? '/api/privacy/setup'
      : mode === 'reset'
        ? '/api/privacy/reset'
        : '/api/privacy/unlock'
    const payload = mode === 'reset' ? { accountPassword, newPassword: password } : { password }
    const result = await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if ((mode === 'setup' || mode === 'reset') && result.user) {
      state.user = { ...state.user, ...result.user }
    }
    state.privacyUnlocked = true
    privacyHeartbeatAt = Date.now()
    updatePrivacyIndicator()
    window.VaultTransfers?.render()
    notePrivacyActivity()
    closePrivacyAuthDialog(true)
    if (mode === 'reset') notify('隐私密码已重置，旧解锁会话已失效', 'ok')
  } catch (error) {
    errorBox.textContent = error.message
    errorBox.hidden = false
  } finally {
    submit.disabled = false
  }
}

function notePrivacyActivity() {
  if (!state.privacyUnlocked) return
  clearPrivacyIdleTimer()
  privacyIdleTimer = setTimeout(async () => {
    if (!state.privacyUnlocked) return
    const switchToAll = state.privacyMode
    notify('隐私空间长时间未操作，已自动锁定', 'ok')
    await lockPrivacySpace({ switchToAll })
  }, PRIVACY_IDLE_MS)

  // 本地活动只负责 10 分钟空闲锁定；后端令牌还需要在活跃期间续签，
  // 否则观看长视频超过 15 分钟后，后续 Range 请求会突然变成 404。
  const now = Date.now()
  if (privacyHeartbeatPromise || now - privacyHeartbeatAt < PRIVACY_HEARTBEAT_MS) return
  const request = api('/api/privacy/heartbeat', { method: 'POST' })
  privacyHeartbeatPromise = request
  request.then(() => {
    privacyHeartbeatAt = Date.now()
  }).catch(async (error) => {
    if (privacyHeartbeatPromise !== request) return
    if (error.code === 'PRIVACY_LOCKED' || error.status === 401) {
      notify('隐私空间已失效，请重新解锁', 'ok')
      await lockPrivacySpace({ switchToAll: state.privacyMode, skipHeartbeatWait: true })
    }
  }).finally(() => {
    if (privacyHeartbeatPromise === request) privacyHeartbeatPromise = null
  })
}

/**
 * 立即锁定隐私空间并清理服务端隐私 Cookie。
 *
 * @param {{switchToAll?: boolean, silent?: boolean, skipHeartbeatWait?: boolean}} options
 *   switchToAll=true 时切回“全部”并刷新；silent 透传给 refresh；
 *   skipHeartbeatWait=true 供心跳失败路径使用，避免等待自身请求造成死锁。
 * @returns {Promise<void>}
 * 副作用：关闭灯箱和隐私弹窗、清除定时器、发起 /api/privacy/lock 请求。
 */
async function lockPrivacySpace({ switchToAll = false, silent = true, skipHeartbeatWait = false } = {}) {
  clearPrivacyIdleTimer()
  // 若心跳请求正在途中，先等它落地，再清 Cookie，避免响应把刚清除的解锁状态又写回来。
  if (!skipHeartbeatWait && privacyHeartbeatPromise) {
    try { await privacyHeartbeatPromise } catch { /* 下面统一清除 Cookie */ }
  }
  const wasPrivate = state.privacyMode || state.privacyUnlocked
  if (wasPrivate) window.VaultTransfers?.pausePrivate()
  state.privacyMode = false
  state.privacyUnlocked = false
  privacyHeartbeatAt = 0
  closePrivacyAuthDialog(false)
  closeLightbox()
  updatePrivacyIndicator()
  window.VaultTransfers?.render()
  if (state.user) {
    try { await api('/api/privacy/lock', { method: 'POST' }) } catch { /* 本地状态仍然立即锁定 */ }
  }
  if (switchToAll) {
    state.category = 'all'
    state.query = ''
    state.page = 1
    state.folderId = null
    state.currentFolder = null
    state.breadcrumbs = []
    $('#search-input').value = ''
    $('#privacy-btn').classList.remove('is-active')
    $('#trash-btn').classList.remove('is-active')
    $$('#cat-list .cat-item').forEach((item) => item.classList.toggle('is-active', item.dataset.cat === 'all'))
    await refresh({ silent })
  } else if (wasPrivate) {
    updatePrivacyIndicator()
  }
}

async function recoverPrivacyAccess() {
  state.privacyUnlocked = false
  updatePrivacyIndicator()
  if (await requestPrivacyUnlock()) {
    state.privacyUnlocked = true
    updatePrivacyIndicator()
    notePrivacyActivity()
    await refresh({ silent: true })
  } else {
    await lockPrivacySpace({ switchToAll: true })
  }
}

async function enterPrivacySpace() {
  if (state.transferMode && window.VaultTransfers) window.VaultTransfers.leave()
  if (state.privacyMode && state.privacyUnlocked) {
    await lockPrivacySpace({ switchToAll: true })
    return
  }
  const unlocked = await requestPrivacyUnlock()
  if (!unlocked) return
  state.privacyMode = true
  state.privacyUnlocked = true
  state.category = 'all'
  state.query = ''
  state.page = 1
  state.folderId = null
  state.currentFolder = null
  state.breadcrumbs = []
  $('#search-input').value = ''
  $$('#cat-list .cat-item').forEach((item) => item.classList.remove('is-active'))
  $('#trash-btn').classList.remove('is-active')
  $('#privacy-btn').classList.add('is-active')
  updatePrivacyIndicator()
  notePrivacyActivity()
  await refresh()
}

/**
 * 切换到「已登录」界面：隐藏登录页，显示主界面，并把用户信息填进去。
 *
 * 注意 HTML 里两个视图都带 hidden 属性，所以程序启动时会短暂空白一下，
 * 直到 boot() 判断完登录状态、调用其中某一个函数。
 */
function showApp() {
  $('#auth-view').hidden = true
  $('#app-view').hidden = false

  // 有昵称用昵称，没有就取邮箱 @ 前面那段
  const name = state.user.nickname || state.user.email.split('@')[0]
  $('#user-name').textContent = name
  $('#user-avatar').textContent = name.slice(0, 1).toUpperCase()   // 头像显示首字
  updatePrivacyIndicator()
  $('#dropdown-name').textContent = name
  $('#dropdown-mail').textContent = state.user.email
}

/* ───────────────────────────── 认证 ───────────────────────────── */

function bindAuth() {
  $$('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.authTab
      $$('[data-auth-tab]').forEach((b) => {
        const selected = b === btn
        b.classList.toggle('is-active', selected)
        b.setAttribute('aria-selected', String(selected))
      })
      $('#login-form').hidden = tab !== 'login'
      $('#register-form').hidden = tab !== 'register'
      $$('.form-error').forEach((node) => { node.hidden = true })
    })
  })

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const errorBox = $('[data-error]', form)
    errorBox.hidden = true
    const submit = $('button[type="submit"]', form)
    submit.disabled = true
    try {
      const payload = {
        email: form.email.value.trim(),
        password: form.password.value,
      }
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      state.user = user
      form.reset()
      showApp()
      await refresh()
    } catch (error) {
      errorBox.textContent = error.message
      errorBox.hidden = false
    } finally {
      submit.disabled = false
    }
  })

  $('#register-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const errorBox = $('[data-error]', form)
    errorBox.hidden = true
    const submit = $('button[type="submit"]', form)
    submit.disabled = true
    try {
      const payload = {
        email: form.email.value.trim(),
        nickname: form.nickname.value.trim(),
        password: form.password.value,
        // 服务端未配置注册码时这个字段是空的，后端会直接忽略
        registrationCode: form.registrationCode.value.trim(),
      }
      const { user } = await api('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      state.user = user
      form.reset()
      showApp()
      await refresh()
      notify('账号已创建，欢迎使用', 'ok')
    } catch (error) {
      errorBox.textContent = error.message
      errorBox.hidden = false
    } finally {
      submit.disabled = false
    }
  })

  // 用户菜单
  const chip = $('#user-chip')
  const dropdown = $('#user-dropdown')
  chip.addEventListener('click', (event) => {
    event.stopPropagation()
    const open = dropdown.hidden
    dropdown.hidden = !open
    chip.setAttribute('aria-expanded', String(open))
  })
  document.addEventListener('click', () => {
    dropdown.hidden = true
    chip.setAttribute('aria-expanded', 'false')
  })
  dropdown.addEventListener('click', (event) => event.stopPropagation())

  $('#logout-btn').addEventListener('click', async () => {
    try {
      // 先完成隐私 Cookie 清理，避免正在途中的心跳在退出后又把解锁 Cookie 写回来。
      if (state.privacyUnlocked) await lockPrivacySpace()
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      /* 即使请求失败也回到登录页 */
    }
    dropdown.hidden = true
    showAuth()
  })

  // 修改密码
  $('#open-password').addEventListener('click', () => {
    dropdown.hidden = true
    const modal = $('#password-modal')
    $('[data-error]', modal).hidden = true
    $('#password-form').reset()
    modal.hidden = false
    setTimeout(() => $('#password-form [name="oldPassword"]').focus(), 0)
  })

  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const errorBox = $('[data-error]', form)
    errorBox.hidden = true
    const submit = $('button[type="submit"]', form)
    submit.disabled = true
    try {
      await api('/api/auth/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword: form.oldPassword.value,
          newPassword: form.newPassword.value,
        }),
      })
      $('#password-modal').hidden = true
      form.reset()
      // 修改账号密码会让服务端清除隐私 Cookie，前端同步回到锁定状态。
      if (state.privacyUnlocked) await lockPrivacySpace({ switchToAll: state.privacyMode })
      notify('密码已更新', 'ok')
    } catch (error) {
      errorBox.textContent = error.message
      errorBox.hidden = false
    } finally {
      submit.disabled = false
    }
  })
}

/* ───────────────────────────── 列表渲染 ───────────────────────────── */

function fileGlyph(record) {
  const ext = extOf(record.name)
  const icons = {
    doc: '<path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10A2.5 2.5 0 0 0 19.5 18V9.5z"/><path d="M13.5 3.5v6h6"/><path d="M8 13h7M8 16.5h4.5"/>',
    zip: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M11 4v3m2 1v3m-2 1v3m2 1v3"/>',
    pdf: '<path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10A2.5 2.5 0 0 0 19.5 18V9.5z"/><path d="M13.5 3.5v6h6"/><path d="M8.5 17v-4.5h1.6a1.3 1.3 0 0 1 0 2.6H8.5"/>',
  }
  const key = /^(DOC|DOCX|TXT|MD|RTF|XLS|XLSX|CSV|PPT|PPTX)$/.test(ext)
    ? 'doc'
    : /^(ZIP|RAR|7Z|TAR|GZ)$/.test(ext)
      ? 'zip'
      : ext === 'PDF'
        ? 'pdf'
        : null
  const path = icons[key] || '<path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10A2.5 2.5 0 0 0 19.5 18V9.5z"/><path d="M13.5 3.5v6h6"/>'

  return `<div class="file-glyph">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>
      <small>${escapeHtml(ext)}</small>
    </div>`
}

/** 音乐文件的占位图：一个音符 + 扩展名，比通用文件图标更好认。 */
function musicGlyph(record) {
  return `<div class="file-glyph music-glyph">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 17.5V5.2l11-1.9v12.3"/><circle cx="6.2" cy="17.6" r="2.8"/><circle cx="17.2" cy="15.7" r="2.8"/>
      </svg>
      <small>${escapeHtml(extOf(record.name))}</small>
    </div>`
}

/**
 * 把「还有多久自动清除」变成人话。
 * 服务端会下发 expiresAt，前端直接用，不必自己再算一遍 24 小时。
 */
function trashRemainText(record) {
  const expires = record.expiresAt
    ? Date.parse(record.expiresAt)
    : Date.parse(record.deletedAt) + state.ttlMs
  if (Number.isNaN(expires)) return '待清除'

  const left = expires - Date.now()
  if (left <= 0) return '即将清除'
  if (left >= 60 * 60 * 1000) return `${Math.floor(left / (60 * 60 * 1000))} 小时后清除`
  return `${Math.max(1, Math.floor(left / 60000))} 分钟后清除`
}

/**
 * 照片和视频封面优先使用服务端缓存的 JPEG 缩略图。
 * 照片生成失败时回退原图；视频失败时回退到原视频取帧。
 */
function setupMediaThumbnails(root = document) {
  $$('img[data-media-thumb]', root).forEach((img) => {
    const videoFallback = img.nextElementSibling
    const canFallbackToVideo = videoFallback && videoFallback.matches('video[data-video-fallback]')
    let usedOriginalImage = false

    const handleError = () => {
      if (!img.isConnected) return
      const originalSrc = img.dataset.fallbackSrc || ''

      if (originalSrc && !usedOriginalImage) {
        usedOriginalImage = true
        img.src = originalSrc
        return
      }

      if (canFallbackToVideo) {
        img.remove()
        videoFallback.hidden = false
        videoFallback.src = videoFallback.dataset.src || ''
        videoFallback.load()
        return
      }

      img.remove()
    }

    img.addEventListener('error', handleError)
    if (img.complete && img.naturalWidth === 0) handleError()
  })
}

/**
 * 渲染文件卡片。
 *
 * 操作按钮必须与 .card-thumb 同级：网格模式仍绝对定位到缩略图右上角，
 * 列表模式则由整张卡片作为定位容器，把按钮放到行最右侧。若继续放在
 * .card-thumb 内，会被缩略图的 overflow:hidden 限制在左侧小区域内。
 */
function cardHtml(record) {
  const raw = apiUrl(`/api/files/${record.id}/raw`)
  const inTrash = Boolean(record.deletedAt)
  const inPrivacy = Boolean(record.isPrivate)

  let thumb
  if (record.category === 'image') {
    const thumbnail = apiUrl(`/api/files/${record.id}/thumbnail`)
    thumb = `<img class="media-thumb" src="${thumbnail}" alt="" loading="lazy" decoding="async" draggable="false" data-media-thumb data-fallback-src="${raw}">`
  } else if (record.category === 'video') {
    const thumbnail = apiUrl(`/api/files/${record.id}/thumbnail`)
    thumb = `<img class="media-thumb" src="${thumbnail}" alt="" loading="lazy" decoding="async" draggable="false" data-media-thumb>
      <video data-video-fallback data-src="${raw}#t=0.5" preload="none" muted playsinline draggable="false" hidden></video>
      <div class="card-play"><span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg></span></div>`
  } else if (record.category === 'music') {
    thumb = musicGlyph(record)
  } else {
    thumb = fileGlyph(record)
  }

  // 回收站里的卡片：角标显示倒计时，操作换成「恢复 / 彻底删除」
  const badge = inTrash
    ? `<span class="card-badge is-trash" data-cat="trash"><i></i>${escapeHtml(trashRemainText(record))}</span>`
    : inPrivacy
      ? `<span class="card-badge is-private" data-cat="private"><i></i>隐私</span>`
      : `<span class="card-badge" data-cat="${record.category}"><i></i>${CATEGORY_LABEL[record.category]}</span>`

  const downloadAction = `<a href="${apiUrl(`/api/files/${record.id}/download`)}" title="下载" aria-label="下载" data-download="${record.id}" data-no-open>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg>
    </a>`
  const restoreAction = `<button type="button" title="恢复" aria-label="恢复" data-restore data-no-open>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a8 8 0 1 1 2.3 7"/><path d="M4 5v5h5"/></svg>
    </button>`
  const moreAction = `<button type="button" title="更多操作" aria-label="更多操作" data-more data-no-open aria-haspopup="menu">
      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
    </button>`
  const actions = inTrash ? `${restoreAction}${moreAction}` : `${downloadAction}${moreAction}`
  return `<article class="card${inTrash ? ' is-in-trash' : ''}${inPrivacy ? ' is-private' : ''}" data-id="${record.id}" data-drag-kind="file" draggable="${!inTrash && !inPrivacy}" tabindex="0">
    <div class="card-thumb" data-open>
      ${badge}
      ${thumb}
    </div>
    <div class="card-actions">${actions}</div>
    <div class="card-body">
      <div class="card-name" title="${escapeHtml(record.name)}">${escapeHtml(record.name)}</div>
      <div class="card-meta">${formatSize(record.size)} · ${formatDate(record.createdAt)}</div>
    </div>
  </article>`
}

/** 渲染文件夹卡片；操作区与缩略图同级的原因同 cardHtml()。 */
function folderCardHtml(folder) {
  const inTrash = Boolean(folder.deletedAt)
  const badge = inTrash
    ? `<span class="card-badge is-trash" data-cat="trash"><i></i>${escapeHtml(trashRemainText(folder))}</span>`
    : '<span class="card-badge" data-cat="folder"><i></i>文件夹</span>'
  const downloadAction = `<a href="${apiUrl(`/api/folders/${folder.id}/download`)}" download title="下载文件夹" aria-label="下载文件夹" data-folder-download data-no-open>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg>
    </a>`
  const restoreAction = `<button type="button" title="恢复文件夹" aria-label="恢复文件夹" data-folder-restore data-no-open>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a8 8 0 1 1 2.3 7"/><path d="M4 5v5h5"/></svg>
    </button>`
  const moreAction = `<button type="button" title="更多操作" aria-label="更多操作" data-more data-no-open aria-haspopup="menu">
      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
    </button>`
  const actions = inTrash ? `${restoreAction}${moreAction}` : `${downloadAction}${moreAction}`
  return `<article class="card folder-card${inTrash ? ' is-in-trash' : ''}" data-folder-id="${folder.id}" data-drag-kind="folder" draggable="${!inTrash}"${inTrash ? '' : ' data-folder-open'} tabindex="${inTrash ? '-1' : '0'}">
    <div class="card-thumb">
      ${badge}
      <div class="folder-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 6.8A1.8 1.8 0 0 1 5.3 5h4.2l1.8 2h7.4a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V6.8Z"/></svg>
      </div>
    </div>
    <div class="card-actions">${actions}</div>
    <div class="card-body">
      <div class="card-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</div>
      <div class="card-meta">文件夹 · ${formatDate(folder.createdAt)}</div>
    </div>
  </article>`
}

function closeCardMenu() {
  const menu = $('#card-menu')
  if (menu) menu.hidden = true
}

function openCardMenu(anchor, kind, id) {
  const menu = $('#card-menu')
  const record = kind === 'file'
    ? state.files.find((file) => file.id === id)
    : state.folders.find((folder) => folder.id === id)
  if (!menu || !record || !anchor) return

  let items
  if (kind === 'folder') {
    items = record.deletedAt
      ? [{ action: 'folder-purge', label: '彻底删除', danger: true }]
      : [
          { action: 'folder-rename', label: '重命名' },
          { action: 'folder-move', label: '移动到文件夹' },
          { action: 'folder-delete', label: '删除', danger: true },
        ]
  } else if (record.deletedAt) {
    items = [{ action: 'purge', label: '彻底删除', danger: true }]
  } else if (record.isPrivate) {
    items = [
      { action: 'unprivate', label: '移出隐私空间' },
      { action: 'private-delete', label: '彻底删除', danger: true },
    ]
  } else {
    items = [
      { action: 'rename', label: '重命名' },
      { action: 'move', label: '移动到文件夹' },
      { action: 'private', label: '移入隐私空间' },
      { action: 'delete', label: '删除', danger: true },
    ]
  }

  menu.dataset.kind = kind
  menu.dataset.id = id
  menu.innerHTML = items.map((item) => (
    `<button type="button" role="menuitem" data-card-menu-action="${item.action}" class="${item.danger ? 'is-danger' : ''}">${item.label}</button>`
  )).join('')
  menu.hidden = false

  const rect = anchor.getBoundingClientRect()
  const width = menu.offsetWidth || 184
  const height = menu.offsetHeight || 160
  let left = Math.min(window.innerWidth - width - 10, Math.max(10, rect.right - width))
  let top = rect.bottom + 6
  if (top + height > window.innerHeight - 10) top = Math.max(10, rect.top - height - 6)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
}

function runCardMenuAction(action) {
  const menu = $('#card-menu')
  const kind = menu && menu.dataset.kind
  const id = menu && menu.dataset.id
  closeCardMenu()
  if (!kind || !id) return
  if (kind === 'folder') {
    if (action === 'folder-rename') openRenameDialog('folder', id)
    else if (action === 'folder-move') void openMoveDialog('folder', id)
    else if (action === 'folder-delete') void deleteFolder(id)
    else if (action === 'folder-purge') void purgeFolder(id)
    return
  }
  if (action === 'rename') openRenameDialog('file', id)
  else if (action === 'move') void openMoveDialog('file', id)
  else if (action === 'private') void moveToPrivacy(id)
  else if (action === 'unprivate') void moveOutOfPrivacy(id)
  else if (action === 'delete') void deleteFile(id)
  else if (action === 'private-delete') void deletePrivateFile(id)
  else if (action === 'purge') void purgeFile(id)
}
/** 只在普通文件夹视图显示路径；每个面包屑同时可作为拖拽移动的放置目标。 */
function renderFolderBreadcrumb() {
  const nav = $('#folder-breadcrumb')
  const visible = !state.transferMode && !state.trash && !state.privacyMode && Boolean(state.folderId)
  nav.hidden = !visible
  if (!visible) return
  const items = [
    '<button type="button" class="folder-crumb" data-folder-crumb="root">全部</button>',
    ...state.breadcrumbs.map((folder, index) => {
      const current = index === state.breadcrumbs.length - 1
      return `${index > 0 ? '<span class="folder-crumb-sep">/</span>' : '<span class="folder-crumb-sep">/</span>'}
        <button type="button" class="folder-crumb${current ? ' is-current' : ''}" data-folder-crumb="${folder.id}">${escapeHtml(folder.name)}</button>`
    }),
  ]
  nav.innerHTML = items.join('')
}
/** 把当前视图模式同步到文件网格和两个切换按钮；按钮状态同时暴露给辅助技术。 */
function applyViewMode() {
  const grid = $('#file-grid')
  if (!grid) return
  const list = state.viewMode === 'list'
  grid.classList.toggle('is-list', list)
  $$('[data-view-mode]').forEach((button) => {
    const active = button.dataset.viewMode === state.viewMode
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
  })
}

/** 切换网格 / 列表视图；写入 localStorage 后刷新页面仍保持用户选择。 */
function setViewMode(mode) {
  if (!['grid', 'list'].includes(mode)) return
  state.viewMode = mode
  try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch { /* localStorage 可能不可用 */ }
  applyViewMode()
}
function renderGrid() {
  const grid = $('#file-grid')
  const empty = $('#empty-state')
  const count = $('#view-count')
  const title = $('#view-title')

  // 传输页不是文件列表；让独立模块负责标题、计数和面板，避免列表刷新把它覆盖。
  if (state.transferMode && window.VaultTransfers) {
    window.VaultTransfers.render()
    return
  }

  // 传输页可能把网格隐藏过；回到文件列表时必须恢复，否则数据已加载却不可见。
  grid.hidden = false
  applyViewMode()

  // 回收站是独立视图，标题和分类无关
  title.textContent = state.privacyMode
    ? '隐私空间'
    : state.trash
      ? '回收站'
      : state.currentFolder
        ? state.currentFolder.name
        : CATEGORY_LABEL[state.category]
  count.textContent = `${state.total + state.folders.length} 项`
  $('#trash-banner').hidden = !state.trash
  $('#new-folder-btn').hidden = state.trash || state.privacyMode || state.category !== 'all'
  renderFolderBreadcrumb()

  if (!state.files.length && !state.folders.length) {
    grid.innerHTML = ''
    empty.hidden = false
    const searching = Boolean(state.query)

    if (state.privacyMode) {
      $('#empty-title').textContent = searching ? '没有匹配的隐私文件' : '隐私空间还是空的'
      $('#empty-desc').textContent = searching ? '换个关键词试试。' : '可直接上传文件，或返回「全部」后通过卡片上的锁按钮移入。'
    } else if (state.trash) {
      $('#empty-title').textContent = '回收站是空的'
      $('#empty-desc').textContent = '删除的文件会先放到这里，24 小时内可以恢复。'
    } else if (searching) {
      $('#empty-title').textContent = '没有匹配的文件'
      $('#empty-desc').textContent = '换个关键词试试，或清空搜索框查看全部内容。'
    } else {
      $('#empty-title').textContent = '这里还是空的'
      $('#empty-desc').textContent = state.category === 'all'
        ? '把视频、照片、音乐或文件拖进来，或点击右上角「上传」按钮。'
        : `还没有${CATEGORY_LABEL[state.category]}，上传一些试试。`
    }
    return
  }

  empty.hidden = true
  grid.innerHTML = state.folders.map(folderCardHtml).join('') + state.files.map(cardHtml).join('')
  setupMediaThumbnails(grid)
  $$('.card', grid).forEach((card, index) => {
    card.style.animationDelay = `${Math.min(index * 22, 260)}ms`
  })
}

function renderUsage() {
  const usage = state.usage
  if (!usage) return
  const storageHead = $('.storage-head span')
  if (storageHead) storageHead.textContent = state.privacyMode ? '隐私空间用量' : '存储用量'

  const activeBytes = usage.bytes || 0
  const trashBytes = (usage.trash && usage.trash.bytes) || 0
  const totalBytes = Number.isFinite(usage.totalBytes)
    ? usage.totalBytes
    : activeBytes + trashBytes

  // 普通视图显示正常文件 + 回收站；隐私视图的 usage 由隐私接口单独返回
  $('#storage-value').textContent = formatSize(totalBytes)
  $('#storage-value').title = trashBytes > 0
    ? `正常文件 ${formatSize(activeBytes)}，回收站 ${formatSize(trashBytes)}`
    : ''

  $$('[data-count]').forEach((node) => {
    const key = node.dataset.count
    node.textContent = key === 'all' ? usage.total : (usage.byCategory[key] || 0)
  })
  // 回收站条数（侧栏那个入口）
  const trashCount = $('#trash-count')
  if (trashCount) trashCount.textContent = (usage.trash && usage.trash.total) || 0

  const trashRow = $('#storage-trash-row')
  const trashBar = $('[data-bar="trash"]')
  if (trashRow) trashRow.hidden = trashBytes <= 0
  if (trashBar) trashBar.hidden = trashBytes <= 0

  const total = totalBytes || 1
  $$('[data-bar]').forEach((node) => {
    const key = node.dataset.bar
    const bytes = key === 'trash' ? trashBytes : (usage.bytesByCategory[key] || 0)
    node.style.setProperty('--w', `${(bytes / total) * 100}%`)
  })
  $$('[data-size]').forEach((node) => {
    const key = node.dataset.size
    node.textContent = formatSize(key === 'trash' ? trashBytes : (usage.bytesByCategory[key] || 0))
  })
}

/* ───────────────────────────── 数据加载 ───────────────────────────── */

/** 为普通文件视图组装分类、搜索、排序和分页参数。 */
function buildListParams(offset) {
  /**
   * URLSearchParams 用来安全地拼查询参数。
   * 它会自动处理中文和特殊字符的编码 ——
   * 如果自己拿字符串拼，关键词里的中文会导致服务器返回 400。
   */
  const params = new URLSearchParams()
  if (state.category !== 'all') params.set('category', state.category)
  if (state.folderId) params.set('folderId', state.folderId)
  if (state.query) params.set('q', state.query)
  params.set('sort', state.sort)
  params.set('limit', String(PAGE_SIZE))
  params.set('offset', String(offset))
  return params
}

/** 生成连续页码并在中间过长时插入省略号。 */
function paginationItems(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  const pages = new Set([1, total, current - 1, current, current + 1])
  if (current <= 3) { pages.add(2); pages.add(3); pages.add(4) }
  if (current >= total - 2) { pages.add(total - 1); pages.add(total - 2); pages.add(total - 3) }
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b)
  const result = []
  for (const page of sorted) {
    if (result.length && page - result[result.length - 1] > 1) result.push('ellipsis')
    result.push(page)
  }
  return result
}

/** 更新底部分页。 */
function renderPagination() {
  const nav = $('#pagination')
  if (!nav) return
  if (state.transferMode) {
    nav.hidden = true
    return
  }

  state.pageCount = Math.max(1, Math.ceil(state.total / PAGE_SIZE))
  state.page = Math.min(state.pageCount, Math.max(1, state.page))
  if (state.total <= PAGE_SIZE) {
    nav.hidden = true
    return
  }

  nav.hidden = false
  $('#page-prev').disabled = state.loadingMore || state.page <= 1
  $('#page-next').disabled = state.loadingMore || state.page >= state.pageCount
  $('#page-hint').textContent = `第 ${state.page} / ${state.pageCount} 页 · 共 ${state.total} 项`
  $('#page-numbers').innerHTML = paginationItems(state.page, state.pageCount).map((item) => {
    if (item === 'ellipsis') return '<span class="pagination-ellipsis" aria-hidden="true">…</span>'
    const active = item === state.page
    return `<button type="button" class="page-number${active ? ' is-active' : ''}" data-page="${item}" ${active ? 'aria-current="page"' : ''} ${state.loadingMore ? 'disabled' : ''}>${item}</button>`
  }).join('')
}

/**
 * 按当前视图取一页数据。
 *
 * 普通列表、回收站和隐私空间使用不同接口，但都返回 files / usage / page。
 * 这里统一响应结构，让上层渲染逻辑不必区分数据来源。
 *
 * @param {number} offset 已加载条数
 * @returns {Promise<{files: object[], usage: object, page: object, ttlMs?: number}>}
 */
async function fetchPage(offset) {
  if (state.privacyMode) {
    const params = new URLSearchParams()
    if (state.query) params.set('q', state.query)
    params.set('sort', state.sort)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    return api(`/api/privacy/files?${params}`)
  }
  if (state.trash) {
    const params = new URLSearchParams()
    if (state.query) params.set('q', state.query)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    const data = await api(`/api/trash?${params}`)
    // 服务端下发保留时长，前端用它算倒计时，避免两边各写一份 24 小时
    if (data.ttlMs) state.ttlMs = data.ttlMs
    return data
  }
  return api(`/api/files?${buildListParams(offset)}`)
}

/**
 * 加载当前视图第一页并整体重绘。切换分类、搜索、排序、上传完成和文件操作
 * 都会走这里；重绘保证 DOM 与 state 一致。
 *
 * @param {{silent?: boolean}} options silent=true 时跳过骨架屏，避免静默刷新闪烁
 * @returns {Promise<void>}
 */
async function refresh({ silent = false } = {}) {
  const requestVersion = ++listRequestVersion
  // refresh 会替代任何进行中的分页加载，避免旧分页请求留下永久 loading 状态。
  state.loadingMore = false
  const skeleton = $('#skeleton')

  // 首次加载（列表还是空的）时显示骨架屏占位，让用户知道正在加载
  if (!silent && !state.transferMode && !state.files.length) {
    skeleton.hidden = false
    $('#file-grid').innerHTML = ''
    $('#empty-state').hidden = true
  }

  try {
    // 筛选和排序都由后端做（数据在服务器那边），前端只负责把条件传过去
    let data = await fetchPage((state.page - 1) * PAGE_SIZE)
    if (requestVersion !== listRequestVersion) return
    let pageCount = Math.max(1, Math.ceil(data.page.total / PAGE_SIZE))

    // 删除当前页最后几条后，自动回退到仍然有效的最后一页。
    if (!data.files.length && state.page > pageCount) {
      state.page = pageCount
      data = await fetchPage((state.page - 1) * PAGE_SIZE)
      if (requestVersion !== listRequestVersion) return
      pageCount = Math.max(1, Math.ceil(data.page.total / PAGE_SIZE))
    }

    // 存进状态，再据此重新渲染
    state.files = data.files
    state.folders = data.folders || []
    state.currentFolder = data.folder || null
    state.breadcrumbs = data.breadcrumbs || []
    state.usage = data.usage
    state.total = data.page.total
    state.pageCount = pageCount
    state.hasMore = state.page < state.pageCount

    renderGrid()    // 画文件网格
    renderUsage()   // 画侧栏的用量统计
    renderPagination()
  } catch (error) {
    if (requestVersion !== listRequestVersion) return
    /**
     * PRIVACY_LOCKED 只表示隐私解锁过期，应弹出隐私密码框而不是退出登录；
     * 其它 401 才说明普通登录会话已失效。
     */
    if (error.code === 'PRIVACY_LOCKED') {
      await recoverPrivacyAccess()
      return
    }
    if (error.status === 401) {
      showAuth()
      return
    }
    notify(error.message)
  } finally {
    // 只有最新请求可以结束骨架屏加载状态。
    if (requestVersion === listRequestVersion) skeleton.hidden = true
  }
}

/**
 * 切换到指定页并替换当前列表。
 *
 * @param {number} page 目标页码，从 1 开始
 * @param {{scroll?: boolean}} options scroll=false 供灯箱跨页导航使用
 * @returns {Promise<void>}
 */
async function goToPage(page, { scroll = true } = {}) {
  const target = Math.max(1, Math.min(state.pageCount || 1, Math.floor(Number(page) || 1)))
  if (state.loadingMore || (target === state.page && state.files.length)) return

  const requestVersion = ++listRequestVersion
  state.loadingMore = true
  renderPagination()

  try {
    let actualPage = target
    let data = await fetchPage((actualPage - 1) * PAGE_SIZE)
    if (requestVersion !== listRequestVersion) return
    let pageCount = Math.max(1, Math.ceil(data.page.total / PAGE_SIZE))
    if (!data.files.length && actualPage > pageCount) {
      actualPage = pageCount
      data = await fetchPage((actualPage - 1) * PAGE_SIZE)
      if (requestVersion !== listRequestVersion) return
      pageCount = Math.max(1, Math.ceil(data.page.total / PAGE_SIZE))
    }
    state.files = data.files
    state.folders = data.folders || []
    state.currentFolder = data.folder || null
    state.breadcrumbs = data.breadcrumbs || []
    state.usage = data.usage
    state.total = data.page.total
    state.pageCount = pageCount
    state.page = actualPage
    state.hasMore = state.page < state.pageCount

    renderGrid()
    renderUsage()
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (error) {
    if (requestVersion !== listRequestVersion) return
    if (error.code === 'PRIVACY_LOCKED') {
      await recoverPrivacyAccess()
      return
    }
    if (error.status === 401) {
      showAuth()
      return
    }
    notify(error.message)
  } finally {
    if (requestVersion === listRequestVersion) {
      state.loadingMore = false
      renderPagination()
    }
  }
}
/**
 * 上传入口统一交给 transfers.js 的分块续传队列。
 *
 * 保留这个函数名是为了不改变输入框、拖拽和测试代码的调用方式；真正的分块、
 * 重试、暂停和会话恢复都由独立模块处理。
 */
async function uploadFiles(fileList) {
  if (!window.VaultTransfers) {
    notify('传输模块尚未加载，请刷新页面后重试')
    return
  }
  await window.VaultTransfers.uploadFiles(fileList)
}
/* ───────────────────────────── 图片缩放 ───────────────────────────── */

/**
 * 图片灯箱的缩放与平移状态。
 *   scale  缩放倍数，1 表示完整适配预览区
 *   x / y  相对中心的平移量（屏幕像素）
 *   el     当前图片元素
 *   stage  包裹图片、也是指针事件的接收区域
 */
const zoom = { scale: 1, x: 0, y: 0, el: null, stage: null }
const ZOOM_MIN = 0.5
const ZOOM_MAX = 8
const PAN_MAX_FACTOR = 3

/**
 * 图片用 object-fit: contain 放进元素盒子里，盒子本身通常比实际画面宽或高。
 * 平移边界必须按“真正画出来的图片尺寸”计算，不能拿整个盒子尺寸计算。
 */
function fittedImageSize() {
  const width = zoom.el && zoom.el.clientWidth
  const height = zoom.el && zoom.el.clientHeight
  if (!width || !height) return { width: 0, height: 0 }

  const naturalRatio = zoom.el.naturalWidth > 0 && zoom.el.naturalHeight > 0
    ? zoom.el.naturalWidth / zoom.el.naturalHeight
    : width / height
  const boxRatio = width / height

  return naturalRatio > boxRatio
    ? { width, height: width / naturalRatio }
    : { width: height * naturalRatio, height }
}

/**
 * 限制平移范围，保证图片始终覆盖预览区，不会被拖到完全看不见。
 * 只在某一边放大到超过预览区后才允许那一轴移动。
 */
function clampZoomPan() {
  if (!zoom.el || !zoom.stage || zoom.scale <= 1) {
    zoom.x = 0
    zoom.y = 0
    return
  }

  const image = fittedImageSize()
  const stageWidth = zoom.stage.clientWidth
  const stageHeight = zoom.stage.clientHeight
  const maxX = Math.max(0, (image.width * zoom.scale - stageWidth) / 2)
  const maxY = Math.max(0, (image.height * zoom.scale - stageHeight) / 2)

  zoom.x = Math.min(maxX, Math.max(-maxX, zoom.x))
  zoom.y = Math.min(maxY, Math.max(-maxY, zoom.y))
}

/**
 * 高倍缩放时，画面移动一屏幕仍需要很大的指针位移。
 * 随倍率把拖动速度从 1x 平滑提高到 3x，800% 时可以更快到达图片边缘。
 */
function panFactorForScale(scale) {
  const progress = Math.min(1, Math.max(0, (scale - 1) / (ZOOM_MAX - 1)))
  return 1 + progress * (PAN_MAX_FACTOR - 1)
}

function applyZoom() {
  if (!zoom.el) return
  clampZoomPan()
  zoom.el.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`
  $('#zoom-level').textContent = `${Math.round(zoom.scale * 100)}%`
  zoom.el.classList.toggle('is-zoomed', zoom.scale > 1)
  $('#zoom-out').disabled = zoom.scale <= ZOOM_MIN + 0.001
  $('#zoom-in').disabled = zoom.scale >= ZOOM_MAX - 0.001
}

function resetZoom() {
  zoom.scale = 1
  zoom.x = 0
  zoom.y = 0
  zoom.el = null
  zoom.stage = null
  $('#zoom-level').textContent = '100%'
  $('#zoom-controls').hidden = true
}

/**
 * 以某个点为锚点缩放到目标倍数。
 *
 * 关键是「锚点不动」：鼠标指着的那块图像，缩放前后应该还在指针下面。
 * 设锚点相对中心的位置是 p，当前平移是 x，那么指针下那块图在图像坐标系里的
 * 位置是 (p - x) / scale。缩放后要让它仍停在 p：
 *   p = 新x + (p - 旧x) / 旧scale * 新scale
 * 整理得  新x = p - (p - 旧x) * (新scale / 旧scale)
 *
 * @param {number} nextScale 目标倍数，自动限制在 ZOOM_MIN..ZOOM_MAX
 * @param {number} anchorX 锚点相对预览区中心的 X 像素偏移
 * @param {number} anchorY 锚点相对预览区中心的 Y 像素偏移
 * @returns {void}
 */
function zoomTo(nextScale, anchorX = 0, anchorY = 0) {
  if (!zoom.el) return
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextScale))
  if (Math.abs(next - zoom.scale) < 0.001) return

  const ratio = next / zoom.scale
  zoom.x = anchorX - (anchorX - zoom.x) * ratio
  zoom.y = anchorY - (anchorY - zoom.y) * ratio
  zoom.scale = next

  // 回到适应窗口或更小时把位移清零，免得图片停在偏心的位置
  if (next <= 1) {
    zoom.x = 0
    zoom.y = 0
  }
  applyZoom()
}

/**
 * 给灯箱图片绑定滚轮、双击、拖动和双指捏合缩放。
 *
 * @param {HTMLImageElement} img 灯箱中的图片元素
 * @returns {void}
 * 副作用：读取并更新模块级 zoom 状态，修改 transform/class，注册 DOM 指针事件。
 */
function setupImageZoom(img) {
  const stage = img.parentElement
  if (!stage) return
  zoom.el = img
  zoom.stage = stage
  zoom.scale = 1
  zoom.x = 0
  zoom.y = 0
  applyZoom()
  requestAnimationFrame(() => stage.focus({ preventScroll: true }))

  const centerOf = () => {
    const rect = stage.getBoundingClientRect()
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 }
  }

  stage.addEventListener('wheel', (event) => {
    event.preventDefault()
    const { cx, cy } = centerOf()
    const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2
    zoomTo(zoom.scale * factor, event.clientX - cx, event.clientY - cy)
  }, { passive: false })

  stage.addEventListener('dblclick', (event) => {
    if (zoom.scale > 1) {
      zoomTo(1)
      return
    }
    const { cx, cy } = centerOf()
    zoomTo(2.5, event.clientX - cx, event.clientY - cy)
  })

  // 用 Pointer Events 统一处理鼠标和触屏，省掉两套代码
  const pointers = new Map()
  let dragging = false
  let lastPointerX = 0
  let lastPointerY = 0
  let pinchStart = 0
  let pinchBase = 1

  const pinchDistance = () => {
    const [a, b] = [...pointers.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  stage.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.size === 2) {
      // 进入捏合模式
      pinchStart = pinchDistance()
      pinchBase = zoom.scale
      dragging = false
    } else if (pointers.size === 1) {
      // 无论当前是否放大都捕获指针，保证双指手势不会在中途丢失
      stage.setPointerCapture(event.pointerId)
      lastPointerX = event.clientX
      lastPointerY = event.clientY
      if (zoom.scale > 1) {
        dragging = true
        stage.classList.add('is-dragging')
      }
    }
  })

  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.size === 2 && pinchStart > 0) {
      const [a, b] = [...pointers.values()]
      const rect = stage.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      zoomTo(
        pinchBase * (pinchDistance() / pinchStart),
        (a.x + b.x) / 2 - cx,
        (a.y + b.y) / 2 - cy,
      )
      return
    }
    if (!dragging) return

    const dx = event.clientX - lastPointerX
    const dy = event.clientY - lastPointerY
    lastPointerX = event.clientX
    lastPointerY = event.clientY
    if (!dx && !dy) return

    const factor = panFactorForScale(zoom.scale)
    zoom.x += dx * factor
    zoom.y += dy * factor
    applyZoom()
  })

  const endPointer = (event) => {
    pointers.delete(event.pointerId)
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
    if (pointers.size < 2) pinchStart = 0
    if (pointers.size === 0) {
      dragging = false
      stage.classList.remove('is-dragging')
    }
  }

  stage.addEventListener('pointerup', endPointer)
  stage.addEventListener('pointercancel', endPointer)
}

/* ───────────────────────────── 音乐播放器 ───────────────────────────── */

/** 把秒数格式化成播放器里常见的 mm:ss / h:mm:ss。 */
function formatPlaybackTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 音乐灯箱使用自己的播放控件，不依赖各浏览器长得不一样的 <audio controls>。
 * 同时保留原生 audio 元素负责解码与播放，并显式处理格式不支持的错误。
 */
function setupAudioPlayer(container) {
  const audio = $('.audio-element', container)
  if (!audio) return

  const seek = $('.audio-seek', container)
  const volume = $('.audio-volume input', container)
  const currentLabel = $('[data-audio-current]', container)
  const durationLabel = $('[data-audio-duration]', container)
  const toggles = $$('[data-audio-toggle]', container)
  const symbols = $$('[data-audio-symbol]', container)
  const toggleLabels = $$('[data-audio-toggle-label]', container)
  const errorBox = $('.audio-error', container)

  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>'
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'

  const applyPlayState = (playing) => {
    symbols.forEach((node) => { node.innerHTML = playing ? PAUSE_ICON : PLAY_ICON })
    toggles.forEach((node) => {
      node.setAttribute('aria-label', playing ? '暂停' : '播放')
      node.setAttribute('aria-pressed', String(playing))
    })
    toggleLabels.forEach((node) => { node.textContent = playing ? '暂停' : '播放' })
    container.classList.toggle('is-playing', playing)
  }

  const syncPlayState = () => {
    applyPlayState(!audio.paused && !audio.ended)
  }

  const syncProgress = () => {
    const duration = audio.duration
    const ratio = Number.isFinite(duration) && duration > 0
      ? Math.min(1, Math.max(0, audio.currentTime / duration))
      : 0
    seek.value = String(Math.round(ratio * 1000))
    currentLabel.textContent = formatPlaybackTime(audio.currentTime)
    durationLabel.textContent = formatPlaybackTime(duration)
    if (!audio.paused && state.privacyMode) notePrivacyActivity()
  }

  let progressTimer = 0
  const stopProgressTimer = () => {
    clearInterval(progressTimer)
    progressTimer = 0
  }
  const startProgressTimer = () => {
    stopProgressTimer()
    syncProgress()
    // timeupdate 在不同浏览器里的频率差异很大，补一个轻量定时器让进度条稳定更新
    progressTimer = setInterval(syncProgress, 250)
  }

  const startPlayback = () => {
    const playback = audio.play()
    // 部分内嵌浏览器不派发 play 事件；先按用户意图显示播放状态，
    // 如果浏览器随后拒绝自动播放，再在 catch 里恢复成播放按钮。
    applyPlayState(true)
    startProgressTimer()
    if (playback && typeof playback.then === 'function') {
      playback.then(() => {
        syncPlayState()
        if (!audio.paused) startProgressTimer()
      }).catch(() => {
        stopProgressTimer()
        applyPlayState(false)
      })
    }
  }

  const toggle = () => {
    if (audio.paused || audio.ended) {
      startPlayback()
    } else {
      audio.pause()
      stopProgressTimer()
      syncPlayState()
    }
  }

  toggles.forEach((node) => node.addEventListener('click', toggle))
  audio.addEventListener('play', () => {
    syncPlayState()
    startProgressTimer()
  })
  audio.addEventListener('pause', () => {
    syncPlayState()
    stopProgressTimer()
  })
  audio.addEventListener('ended', () => {
    syncPlayState()
    stopProgressTimer()
  })
  audio.addEventListener('loadedmetadata', () => {
    errorBox.hidden = true
    syncProgress()
  })
  audio.addEventListener('durationchange', syncProgress)
  audio.addEventListener('timeupdate', syncProgress)
  audio.addEventListener('error', () => {
    errorBox.hidden = false
    errorBox.textContent = '当前浏览器无法播放这个音频格式，请下载后用本地播放器打开。'
    container.classList.add('has-error')
  })

  seek.addEventListener('input', () => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
    audio.currentTime = (Number(seek.value) / 1000) * audio.duration
    syncProgress()
  })

  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value) / 100
  })

  audio.volume = Number(volume.value) / 100
  syncPlayState()
  syncProgress()
  startPlayback()
}

/* ───────────────────────────── 灯箱容器 ───────────────────────────── */

/** 当前预览文件在已加载列表中的位置。 */
function lightboxRecordIndex(id = state.lightboxId) {
  return state.files.findIndex((row) => row.id === id)
}

/** 根据当前位置更新左右切换按钮。 */
function updateLightboxNavigation() {
  const prev = $('#lightbox-prev')
  const next = $('#lightbox-next')
  const index = lightboxRecordIndex()
  const hasMultiple = state.total > 1 || state.files.length > 1

  prev.hidden = !hasMultiple
  next.hidden = !hasMultiple
  prev.disabled = state.lightboxNavigating || index < 0 || (index <= 0 && state.page <= 1)
  next.disabled = state.lightboxNavigating || index < 0 || (index >= state.files.length - 1 && state.page >= state.pageCount)
}

/** 切换预览时先暂停上一份音视频，避免后台继续播放。 */
function pauseLightboxMedia() {
  const media = $('#lightbox-body audio, #lightbox-body video')
  if (media) media.pause()
}

const previewPreloadCache = new Map()
const PRELOAD_CACHE_LIMIT = 8

function releasePreviewResource(resource) {
  if (!resource) return
  if (resource.tagName === 'VIDEO') {
    resource.pause()
    resource.removeAttribute('src')
    resource.load()
  } else {
    resource.removeAttribute('src')
  }
}

function rememberPreviewPreload(key, resource) {
  previewPreloadCache.set(key, resource)
  while (previewPreloadCache.size > PRELOAD_CACHE_LIMIT) {
    const oldestKey = previewPreloadCache.keys().next().value
    const oldest = previewPreloadCache.get(oldestKey)
    previewPreloadCache.delete(oldestKey)
    releasePreviewResource(oldest)
  }
}

function clearPreviewPreloads() {
  for (const resource of previewPreloadCache.values()) releasePreviewResource(resource)
  previewPreloadCache.clear()
}

function crossOriginPreview(resource, src) {
  try {
    if (new URL(src, window.location.href).origin !== window.location.origin) {
      resource.crossOrigin = 'use-credentials'
    }
  } catch {
    /* 配置异常时按普通资源加载 */
  }
  return resource
}

/**
 * 预热前后各两张照片；仅对紧邻视频预取 metadata，避免额外下载大量视频。
 * 资源保存在有界缓存中，超出上限会释放旧的 src。
 *
 * @param {number} index 当前灯箱文件在 state.files 中的索引
 * @returns {void}
 */
function preloadAdjacentPreviews(index) {
  if (index < 0) return
  for (const distance of [-2, -1, 1, 2]) {
    const record = state.files[index + distance]
    if (!record) continue

    if (record.category === 'image') {
      const key = `image:${record.id}`
      if (previewPreloadCache.has(key)) continue
      const src = apiUrl(`/api/files/${record.id}/raw`)
      const image = crossOriginPreview(new Image(), src)
      image.decoding = 'async'
      image.src = src
      rememberPreviewPreload(key, image)
      continue
    }

    if (record.category === 'video' && Math.abs(distance) === 1) {
      const key = `video:${record.id}`
      if (previewPreloadCache.has(key)) continue
      const src = apiUrl(`/api/files/${record.id}/preview`)
      const video = crossOriginPreview(document.createElement('video'), src)
      video.preload = 'metadata'
      video.muted = true
      video.src = src
      video.load()
      rememberPreviewPreload(key, video)
    }
  }
}

function videoPlaybackUrl(record, quality) {
  return quality === 'original'
    ? apiUrl(`/api/files/${record.id}/raw`)
    : apiUrl(`/api/files/${record.id}/preview`)
}

/**
 * 用 HEAD 查询 720P 副本是否可用。
 * 服务端只有在副本存在且小于原片时才返回 X-Video-Preview: optimized；
 * 不可用时自动回退原画并更新本地清晰度偏好。
 */
async function refreshVideoQualityAvailability(record) {
  const select = $('#video-quality')
  const option = $('option[value="720p"]', select)
  if (!select || !option) return

  option.disabled = true
  option.textContent = '720P（检测中…）'
  try {
    const response = await fetch(apiUrl(`/api/files/${record.id}/preview`), {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
    })
    if (state.lightboxId !== record.id) return
    const available = response.ok && response.headers.get('X-Video-Preview') === 'optimized'
    option.disabled = !available
    option.textContent = available ? '720P' : '720P（未生成）'
    if (!available && state.videoQuality === '720p') {
      state.videoQuality = 'original'
      select.value = 'original'
      try { localStorage.setItem(VIDEO_QUALITY_KEY, 'original') } catch { /* ignore */ }
    }
  } catch {
    if (state.lightboxId === record.id) option.textContent = '720P（未生成）'
  }
}

/**
 * 切换原画 / 720P，并保留当前播放时间与播放状态。
 * @param {object} record 视频文件记录
 * @param {'720p'|'original'} quality 目标清晰度
 * @returns {void}
 */
function applyVideoQuality(record, quality) {
  const video = $('#lightbox-body video')
  const select = $('#video-quality')
  if (!video || !select) return

  state.videoQuality = quality
  select.value = quality
  try { localStorage.setItem(VIDEO_QUALITY_KEY, quality) } catch { /* ignore */ }

  const targetSrc = videoPlaybackUrl(record, quality)
  if (video.dataset.baseSrc === targetSrc) {
    video.dataset.quality = quality
    return
  }

  const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0
  const shouldResume = !video.paused && !video.ended
  video.pause()
  video.dataset.quality = quality
  video.dataset.baseSrc = targetSrc
  video.src = targetSrc
  video.load()
  video.addEventListener('loadedmetadata', () => {
    try {
      if (resumeAt > 0) video.currentTime = Math.min(resumeAt, video.duration || resumeAt)
    } catch { /* 无法定位时从头播放 */ }
    if (shouldResume) video.play().catch(() => {})
  }, { once: true })
}

/** 视频缓冲或定位时给出明确状态；连续 8 秒无数据时最多自动重连两次。 */
function setupVideoPlayer(record, container) {
  const video = $('video', container)
  const loading = $('[data-video-loading]', container)
  const loadingText = $('[data-video-loading-text]', container)
  if (!video || !loading || !loadingText) return

  if (!video.dataset.baseSrc) video.dataset.baseSrc = video.getAttribute('src') || ''
  let recoveryTimer = 0
  let recoveryAttempts = 0
  let recovering = false
  let lastActivityAt = Date.now()

  const showLoading = (textValue) => {
    loadingText.textContent = textValue
    loading.hidden = false
  }
  const hideLoading = () => {
    loading.hidden = true
    container.classList.remove('has-error')
  }
  const clearRecoveryTimer = () => {
    clearTimeout(recoveryTimer)
    recoveryTimer = 0
  }

  const recoverPlayback = () => {
    if (!video.isConnected || recovering || recoveryAttempts >= 2) return
    if (!video.seeking && video.paused) return
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !video.seeking) return
    // 慢速网络只要仍在持续收到数据，就不要误判为卡死并重启连接
    if (Date.now() - lastActivityAt < 8000) {
      scheduleRecovery()
      return
    }

    recovering = true
    lastActivityAt = Date.now()
    recoveryAttempts += 1
    const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0
    const shouldResume = !video.paused && !video.ended
    showLoading('视频响应超时，正在重新连接…')
    video.pause()

    const baseSrc = video.dataset.baseSrc || video.getAttribute('src') || ''
    const retryUrl = `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}retry=${Date.now()}`
    video.src = retryUrl
    video.load()
    video.addEventListener('loadedmetadata', () => {
      try {
        if (resumeAt > 0) video.currentTime = resumeAt
      } catch {
        /* 视频时长异常时从头开始 */
      }
      if (shouldResume) video.play().catch(() => {})
      lastActivityAt = Date.now()
      recovering = false
    }, { once: true })
  }

  const scheduleRecovery = () => {
    if (recoveryTimer || recovering || recoveryAttempts >= 2) return
    recoveryTimer = setTimeout(() => {
      recoveryTimer = 0
      recoverPlayback()
    }, 8000)
  }

  video.addEventListener('loadstart', () => {
    lastActivityAt = Date.now()
    showLoading('加载视频…')
  })
  video.addEventListener('waiting', () => {
    showLoading('缓冲中…')
    scheduleRecovery()
  })
  video.addEventListener('stalled', () => {
    showLoading('网络较慢，正在重试…')
    scheduleRecovery()
  })
  video.addEventListener('seeking', () => {
    showLoading('正在定位…')
    scheduleRecovery()
  })
  video.addEventListener('seeked', () => {
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      clearRecoveryTimer()
      hideLoading()
    } else {
      scheduleRecovery()
    }
  })
  video.addEventListener('progress', () => {
    lastActivityAt = Date.now()
    clearRecoveryTimer()
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) hideLoading()
    else if (!video.paused || video.seeking) scheduleRecovery()
  })
  video.addEventListener('timeupdate', () => {
    if (!video.paused) {
      if (state.privacyMode) notePrivacyActivity()
      lastActivityAt = Date.now()
      clearRecoveryTimer()
      recoveryAttempts = 0
    }
  })
  video.addEventListener('canplay', () => {
    lastActivityAt = Date.now()
    clearRecoveryTimer()
    hideLoading()
  })
  video.addEventListener('playing', () => {
    lastActivityAt = Date.now()
    clearRecoveryTimer()
    recoveryAttempts = 0
    hideLoading()
  })
  video.addEventListener('error', () => {
    clearRecoveryTimer()
    container.classList.add('has-error')
    showLoading('视频加载失败，请下载后播放')
  })

  if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) hideLoading()
  video.play().catch(() => {
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) hideLoading()
  })
}

/** 按当前筛选和排序顺序切换上一个 / 下一个文件，并支持跨页。 */
async function navigateLightbox(direction) {
  if (!state.lightboxId || state.lightboxNavigating) return
  let index = lightboxRecordIndex()
  if (index < 0) return

  if (direction > 0 && index >= state.files.length - 1 && state.page < state.pageCount) {
    const expectedId = state.lightboxId
    state.lightboxNavigating = true
    updateLightboxNavigation()
    try { await goToPage(state.page + 1, { scroll: false }) } finally { state.lightboxNavigating = false }
    if (state.lightboxId === expectedId && state.files.length) openLightbox(state.files[0].id)
    return
  }

  if (direction < 0 && index <= 0 && state.page > 1) {
    const expectedId = state.lightboxId
    state.lightboxNavigating = true
    updateLightboxNavigation()
    try { await goToPage(state.page - 1, { scroll: false }) } finally { state.lightboxNavigating = false }
    if (state.lightboxId === expectedId && state.files.length) openLightbox(state.files[state.files.length - 1].id)
    return
  }

  index = lightboxRecordIndex()
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= state.files.length) {
    updateLightboxNavigation()
    return
  }
  openLightbox(state.files[targetIndex].id)
}
/**
 * 打开当前已加载列表中的文件预览。
 * 会根据分类创建图片、视频、音频或文件占位视图，并启动相邻文件预加载。
 *
 * @param {string} id 文件 ID，必须已存在于 state.files
 * @returns {void}
 */
function openLightbox(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return
  pauseLightboxMedia()
  state.lightboxId = id

  const raw = apiUrl(`/api/files/${record.id}/raw`)
  const inTrash = Boolean(record.deletedAt)
  const inPrivate = Boolean(record.isPrivate)
  const index = lightboxRecordIndex(id)
  const absoluteIndex = (state.page - 1) * PAGE_SIZE + index
  const position = state.total > 1 && index >= 0 ? ` · ${absoluteIndex + 1} / ${state.total}` : ''
  const summary = `${inPrivate ? '隐私 · ' : ''}${CATEGORY_LABEL[record.category]} · ${formatSize(record.size)} · ${inTrash ? trashRemainText(record) : formatDate(record.createdAt)}`

  $('#lightbox-name').textContent = record.name
  $('#lightbox-sub').textContent = `${summary}${position}`
  $('#lightbox-download').href = apiUrl(`/api/files/${record.id}/download`)

  // 回收站里：显示「恢复」，删除按钮改成「彻底删除」
  $('#lightbox-restore').hidden = !inTrash
  $('#lightbox-private').hidden = inTrash
  $('#lightbox-private').textContent = inPrivate ? '移出隐私空间' : '移入隐私空间'
  $('#lightbox-delete').textContent = (inTrash || inPrivate) ? '彻底删除' : '删除'
  $('#video-quality-control').hidden = record.category !== 'video'

  resetZoom()
  const body = $('#lightbox-body')
  body.classList.toggle('is-media-preview', record.category === 'image' || record.category === 'video')

  if (record.category === 'image') {
    // stage 负责接收指针事件，img 完整适配预览区后再做缩放和平移
    body.innerHTML = `<div class="zoom-stage" tabindex="0" role="group" aria-label="图片预览，可滚轮、双指或双击缩放">
        <img class="zoom-img" src="${raw}" alt="${escapeHtml(record.name)}" draggable="false">
      </div>`
    $('#zoom-controls').hidden = false
    setupImageZoom($('.zoom-img', body))
  } else if (record.category === 'video') {
    const videoSrc = videoPlaybackUrl(record, state.videoQuality)
    $('#video-quality').value = state.videoQuality
    body.innerHTML = `<div class="video-preview" data-video-player>
        <video src="${videoSrc}" data-base-src="${videoSrc}" data-quality="${state.videoQuality}" controls autoplay preload="auto" playsinline></video>
        <div class="video-loading" data-video-loading role="status" aria-live="polite">
          <span class="video-spinner" aria-hidden="true"></span>
          <span data-video-loading-text>加载视频…</span>
        </div>
      </div>`
    setupVideoPlayer(record, body)
    void refreshVideoQualityAvailability(record)
  } else if (record.category === 'music') {
    body.innerHTML = `<div class="audio-preview" data-audio-player>
        <button class="audio-art" type="button" data-audio-toggle aria-label="播放">
          <svg class="audio-note" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 17.5V5.2l11-1.9v12.3"/><circle cx="6.2" cy="17.6" r="2.8"/><circle cx="17.2" cy="15.7" r="2.8"/>
          </svg>
          <span class="audio-art-play" data-audio-symbol></span>
        </button>
        <div class="audio-copy">
          <p class="audio-name">${escapeHtml(record.name)}</p>
          <span class="audio-kind">音乐 · 在线播放</span>
        </div>
        <div class="audio-progress">
          <span data-audio-current>0:00</span>
          <input class="audio-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度">
          <span data-audio-duration>--:--</span>
        </div>
        <div class="audio-controls">
          <button class="audio-toggle-main" type="button" data-audio-toggle aria-label="播放">
            <span data-audio-symbol></span><b data-audio-toggle-label>播放</b>
          </button>
          <label class="audio-volume">音量
            <input type="range" min="0" max="100" value="85" step="1" aria-label="音量">
          </label>
        </div>
        <audio class="audio-element" src="${raw}" preload="metadata"></audio>
        <p class="audio-error" hidden></p>
      </div>`
    setupAudioPlayer($('.audio-preview', body))
  } else {
    body.innerHTML = `<div class="file-preview">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10A2.5 2.5 0 0 0 19.5 18V9.5z"/><path d="M13.5 3.5v6h6"/></svg>
        <p>该格式暂不支持在线预览，可直接下载查看。</p>
      </div>`
  }

  $('#lightbox').hidden = false
  document.body.style.overflow = 'hidden'
  updateLightboxNavigation()
  preloadAdjacentPreviews(index)
}

function closeLightbox() {
  const box = $('#lightbox')
  if (box.hidden) return
  // 先暂停再清空，确保音频进度定时器和播放状态一起结束
  const playingMedia = $('#lightbox-body audio, #lightbox-body video')
  if (playingMedia) playingMedia.pause()
  $('#lightbox-body').innerHTML = ''
  $('#lightbox-body').classList.remove('is-media-preview')
  resetZoom()
  box.hidden = true
  state.lightboxId = null
  state.lightboxNavigating = false
  document.body.style.overflow = ''
}

/** 把界面切到回收站视图，并同步侧栏的选中状态。 */
function enterTrashView() {
  state.trash = true
  state.category = 'all'
  state.query = ''
  state.page = 1
  state.folderId = null
  state.currentFolder = null
  state.breadcrumbs = []
  $('#search-input').value = ''
  $$('#cat-list .cat-item').forEach((item) => item.classList.remove('is-active'))
  $('#trash-btn').classList.add('is-active')
}

async function openTrashView({ silent = false } = {}) {
  enterTrashView()
  await refresh({ silent })
}

/**
 * 删除 = 移入回收站，并立即打开回收站视图。
 * 服务端只是打个时间戳，文件还在，24 小时内都能捞回来。
 */
let renamingType = ''
let renamingId = ''

function closeRenameDialog() {
  $('#rename-modal').hidden = true
  renamingType = ''
  renamingId = ''
}

function openRenameDialog(type, id) {
  const item = type === 'folder'
    ? state.folders.find((folder) => folder.id === id)
    : state.files.find((file) => file.id === id)
  if (!item) return
  renamingType = type
  renamingId = id
  $('#rename-title').textContent = type === 'folder' ? '重命名文件夹' : '重命名文件'
  $('#rename-input').value = item.name
  $('#rename-modal').hidden = false
  $('#rename-input').focus()
  $('#rename-input').select()
}

async function submitRename(event) {
  event.preventDefault()
  if (!renamingType || !renamingId) return
  const name = $('#rename-input').value.trim()
  if (!name) return
  const submit = $('#rename-form button[type="submit"]')
  submit.disabled = true
  try {
    const path = renamingType === 'folder' ? `/api/folders/${renamingId}` : `/api/files/${renamingId}`
    await api(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    closeRenameDialog()
    notify('名称已更新', 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  } finally {
    submit.disabled = false
  }
}
let movingItem = null

/**
 * 把扁平文件夹列表解析成可读路径。
 *
 * 服务端返回全部有效文件夹，前端根据 parentId 临时拼路径，供“移动到文件夹”
 * 下拉框显示。seen 用于防御异常数据形成环时无限递归。
 */
function folderPathLabels(folders) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const paths = new Map()
  const resolve = (folder, seen = new Set()) => {
    if (!folder) return ''
    if (paths.has(folder.id)) return paths.get(folder.id)
    if (seen.has(folder.id)) return folder.name
    seen.add(folder.id)
    const parent = folder.parentId ? byId.get(folder.parentId) : null
    const value = parent ? `${resolve(parent, seen)} / ${folder.name}` : folder.name
    paths.set(folder.id, value)
    return value
  }
  return folders
    .map((folder) => ({ folder, label: resolve(folder) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
}

function closeMoveDialog() {
  $('#move-modal').hidden = true
  movingItem = null
}

/** 文件夹只能放到根目录或非自身子树，避免把树移成环。 */
function folderMoveExclusions(folders, rootId) {
  const excluded = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parentId && excluded.has(folder.parentId) && !excluded.has(folder.id)) {
        excluded.add(folder.id)
        changed = true
      }
    }
  }
  return excluded
}

/**
 * 打开文件 / 文件夹移动弹窗。
 *
 * 移动文件夹时先排除自身及其全部后代，避免用户选中必然触发 FOLDER_CYCLE 的目标；
 * 服务端仍会再次校验，前端过滤只用于改善交互，不能替代后端约束。
 */
async function openMoveDialog(kind, id) {
  const records = kind === 'folder' ? state.folders : state.files
  const record = records.find((row) => row.id === id)
  if (!record) return
  try {
    const data = await api('/api/folders')
    const allFolders = data.folders || []
    const excluded = kind === 'folder' ? folderMoveExclusions(allFolders, id) : new Set()
    const select = $('#move-folder-select')
    const folders = folderPathLabels(allFolders).filter(({ folder }) => !excluded.has(folder.id))
    select.innerHTML = [
      '<option value="">根目录</option>',
      ...folders.map(({ folder, label }) => `<option value="${folder.id}">${escapeHtml(label)}</option>`),
    ].join('')
    select.value = (kind === 'folder' ? record.parentId : record.folderId) || ''
    $('#move-file-name').textContent = `移动「${record.name}」到：`
    movingItem = { kind, id }
    $('#move-modal').hidden = false
    select.focus()
  } catch (error) {
    notify(error.message)
  }
}

async function submitMove(event) {
  event.preventDefault()
  if (!movingItem) return
  const { kind, id } = movingItem
  const folderId = $('#move-folder-select').value || null
  const submit = $('#move-form button[type="submit"]')
  submit.disabled = true
  try {
    await api(kind === 'folder' ? `/api/folders/${id}` : `/api/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kind === 'folder' ? { parentId: folderId } : { folderId }),
    })
    closeMoveDialog()
    notify(kind === 'folder' ? '文件夹已移动' : '文件已移动', 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  } finally {
    submit.disabled = false
  }
}
/** 拖拽移动文件；目标目录未变化时直接返回，避免无意义的 PATCH。 */
async function moveFileToTarget(fileId, folderId) {
  const record = state.files.find((file) => file.id === fileId)
  if (!record || (record.folderId || null) === (folderId || null)) return
  await api(`/api/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId: folderId || null }),
  })
  notify(`已移动：${record.name}`, 'ok')
  await refresh({ silent: true })
}

/** 拖拽移动文件夹；循环目录和同名冲突由服务端最终判定。 */
async function moveFolderToTarget(folderId, parentId) {
  const folder = state.folders.find((item) => item.id === folderId)
  if (!folder || (folder.parentId || null) === (parentId || null)) return
  await api(`/api/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId: parentId || null }),
  })
  notify(`已移动文件夹：${folder.name}`, 'ok')
  await refresh({ silent: true })
}

/** 清除所有文件夹卡片 / 面包屑上的拖拽高亮。 */
function clearDropTargets() {
  $$('.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'))
}

/** 浏览器在 dragover 阶段通常只暴露类型，不暴露 getData() 内容。 */
function isCardDrag(dataTransfer) {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types || []).includes(CARD_DRAG_MIME)
}

/** 从 drop 阶段读取卡片移动载荷；格式异常时视为普通拖拽，不抛出到事件层。 */
function parseDraggedCard(dataTransfer) {
  if (!dataTransfer) return null
  try {
    const value = dataTransfer.getData(CARD_DRAG_MIME)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

/**
 * 把拖拽卡片移动到目标文件夹。
 *
 * 无论移动成功、失败还是载荷无效，都要在 finally 中清理高亮和内部拖拽标记，
 * 否则后续从桌面拖入文件可能被误判为页面内部拖拽。
 */
async function dropCardIntoFolder(dataTransfer, targetFolderId) {
  const item = parseDraggedCard(dataTransfer)
  try {
    if (!item) return
    if (item.kind === 'folder') await moveFolderToTarget(item.id, targetFolderId)
    else if (item.kind === 'file') await moveFileToTarget(item.id, targetFolderId)
  } catch (error) {
    notify(error.message)
  } finally {
    clearDropTargets()
    markInternalDragEnd()
  }
}
/** 新建当前目录下的文件夹。 */
async function createFolder() {
  if (!state.user || state.privacyMode || state.trash) return
  const name = window.prompt('文件夹名称')
  if (!name || !name.trim()) return
  try {
    await api('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), parentId: state.folderId }),
    })
    notify('文件夹已创建', 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  }
}

/** 进入指定文件夹；null 返回根目录。 */
async function openFolder(id) {
  state.folderId = id || null
  state.page = 1
  state.query = ''
  $('#search-input').value = ''
  await refresh()
}

async function deleteFolder(id) {
  const folder = state.folders.find((item) => item.id === id)
  if (!folder) return
  if (!window.confirm(`把文件夹「${folder.name}」及其全部内容移入回收站？\n\n24 小时内可以恢复。`)) return
  try {
    await api(`/api/folders/${id}`, { method: 'DELETE' })
    notify(`已移入回收站：${folder.name}`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  }
}

async function restoreFolder(id) {
  const folder = state.folders.find((item) => item.id === id)
  if (!folder) return
  try {
    await api(`/api/folders/${id}/restore`, { method: 'POST' })
    notify(`已恢复文件夹：${folder.name}`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  }
}

async function purgeFolder(id) {
  const folder = state.folders.find((item) => item.id === id)
  if (!folder) return
  if (!window.confirm(`彻底删除文件夹「${folder.name}」及其中全部文件？\n\n此操作不可恢复。`)) return
  try {
    await api(`/api/trash/folders/${id}`, { method: 'DELETE' })
    notify(`已彻底删除文件夹：${folder.name}`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  }
}
async function deleteFile(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return
  if (!window.confirm(`把「${record.name}」移到回收站？\n\n24 小时内可以恢复，之后会自动清除。`)) return

  try {
    await api(`/api/files/${id}`, { method: 'DELETE' })
    if (state.lightboxId === id) closeLightbox()
    notify(`已移入回收站：${record.name}`, 'ok')
    // 保持当前分类和页码，只刷新列表；用户需要时可自行进入回收站。
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  }
}

/** 将普通文件移入隐私空间。 */
async function moveToPrivacy(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record || record.isPrivate) return
  if (!window.confirm(`把「${record.name}」移入隐私空间？\n\n移入后不会出现在全部、分类搜索和回收站中。`)) return
  if (!(await requestPrivacyUnlock())) return
  try {
    await api(`/api/privacy/files/${id}`, { method: 'POST' })
    if (state.lightboxId === id) closeLightbox()
    notify(`已移入隐私空间：${record.name}`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    if (error.code === 'PRIVACY_LOCKED') await recoverPrivacyAccess()
    else notify(error.message)
  }
}

/** 将隐私文件移回普通空间。 */
async function moveOutOfPrivacy(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record || !record.isPrivate) return
  if (!window.confirm(`把「${record.name}」移出隐私空间？`)) return
  try {
    await api(`/api/privacy/files/${id}/move-out`, { method: 'POST' })
    if (state.lightboxId === id) closeLightbox()
    notify(`已移出隐私空间：${record.name}`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    if (error.code === 'PRIVACY_LOCKED') await recoverPrivacyAccess()
    else notify(error.message)
  }
}

/** 隐私空间内永久删除。 */
async function deletePrivateFile(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return
  if (!window.confirm(`彻底删除「${record.name}」？\n\n隐私空间内的删除不可恢复。`)) return
  try {
    await api(`/api/privacy/files/${id}`, { method: 'DELETE' })
    if (state.lightboxId === id) closeLightbox()
    notify(`已彻底删除：${record.name}`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    if (error.code === 'PRIVACY_LOCKED') await recoverPrivacyAccess()
    else notify(error.message)
  }
}

/** 从回收站恢复。 */
async function restoreFile(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return

  try {
    await api(`/api/files/${id}/restore`, { method: 'POST' })
    if (state.lightboxId === id) closeLightbox()
    notify(`已恢复：${record.name}`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  }
}

/**
 * 彻底删除 —— 这个真的不可恢复，所以要二次确认。
 * 确认框里把文件名带上，避免误删旁边的文件。
 */
async function purgeFile(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return
  if (!window.confirm(`彻底删除「${record.name}」？\n\n此操作不可恢复，文件会立即从磁盘移除。`)) return

  try {
    await api(`/api/trash/${id}`, { method: 'DELETE' })
    if (state.lightboxId === id) closeLightbox()
    notify(`已彻底删除：${record.name}`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  }
}

/** 清空回收站。 */
async function emptyTrash() {
  const total = state.total
  if (!total) return
  if (!window.confirm(`清空回收站？\n\n其中 ${total} 个文件会被立即彻底删除，不可恢复。`)) return

  try {
    const result = await api('/api/trash', { method: 'DELETE' })
    notify(`已清空回收站，删除 ${result.removed} 个文件`, 'ok')
    await refresh({ silent: true })
  } catch (error) {
    notify(error.message)
  }
}

/* ───────────────────────────── 事件绑定 ───────────────────────────── */

function bindApp() {
  // 分类切换
  $('#cat-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-cat]')
    if (!btn) return
    if (state.transferMode && window.VaultTransfers) window.VaultTransfers.leave()
    // 离开隐私空间即重新上锁，之后再次访问必须重新输入隐私密码。
    if (state.privacyMode) await lockPrivacySpace()
    state.category = btn.dataset.cat
    state.page = 1
    state.folderId = null
    state.currentFolder = null
    state.breadcrumbs = []
    state.trash = false                       // 从回收站切回普通列表
    $('#trash-btn').classList.remove('is-active')
    $('#privacy-btn').classList.remove('is-active')
    $$('#cat-list .cat-item').forEach((item) => item.classList.toggle('is-active', item === btn))
    await refresh()
  })

  // 回收站入口：独立视图，进去时清空搜索词，避免带着别的条件看
  $('#trash-btn').addEventListener('click', async () => {
    if (state.transferMode && window.VaultTransfers) window.VaultTransfers.leave()
    if (state.privacyMode) await lockPrivacySpace()
    await openTrashView()
  })

  // 隐私空间入口与密码设置 / 解锁弹窗
  $('#privacy-btn').addEventListener('click', () => { void enterPrivacySpace() })
  $('#privacy-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void submitPrivacyAuth(event.currentTarget)
  })
  $('#privacy-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) closePrivacyAuthDialog(false)
  })
  $('#privacy-reset-link').addEventListener('click', () => {
    const form = $('#privacy-form')
    form.reset()
    applyPrivacyAuthMode('reset')
  })
  $('#privacy-back').addEventListener('click', () => {
    const form = $('#privacy-form')
    form.reset()
    applyPrivacyAuthMode('unlock')
  })

  // 隐私空间中的普通浏览、点击、滚动、键盘操作都会刷新空闲计时；
  // 音视频播放另有 timeupdate 持续调用。
  document.addEventListener('pointerdown', notePrivacyActivity, { passive: true, capture: true })
  document.addEventListener('keydown', notePrivacyActivity, { passive: true, capture: true })
  document.addEventListener('wheel', notePrivacyActivity, { passive: true, capture: true })
  document.addEventListener('touchstart', notePrivacyActivity, { passive: true, capture: true })

  $('#empty-trash-btn').addEventListener('click', emptyTrash)

  // 图片缩放按钮
  $('#zoom-in').addEventListener('click', () => zoomTo(zoom.scale * 1.3))
  $('#zoom-out').addEventListener('click', () => zoomTo(zoom.scale / 1.3))
  $('#zoom-reset').addEventListener('click', () => zoomTo(1))

  $('#new-folder-btn').addEventListener('click', () => { void createFolder() })
  $$('[data-view-mode]').forEach((button) => {
    button.addEventListener('click', () => setViewMode(button.dataset.viewMode))
  })
  $('#folder-breadcrumb').addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-folder-crumb]')
    if (!crumb) return
    const target = crumb.dataset.folderCrumb
    void openFolder(target === 'root' ? null : target)
  })
  // 面包屑本身也是放置目标：拖到「全部」回到根目录，拖到上级路径则上移。
  const breadcrumb = $('#folder-breadcrumb')
  breadcrumb.addEventListener('dragover', (event) => {
    if (!isCardDrag(event.dataTransfer)) return
    const crumb = event.target.closest('[data-folder-crumb]')
    if (!crumb) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    if (!crumb.classList.contains('is-drop-target')) {
      clearDropTargets()
      crumb.classList.add('is-drop-target')
    }
  })
  breadcrumb.addEventListener('dragleave', (event) => {
    const crumb = event.target.closest('[data-folder-crumb]')
    if (!crumb) return
    if (!(event.relatedTarget instanceof Node) || !crumb.contains(event.relatedTarget)) {
      crumb.classList.remove('is-drop-target')
    }
  })
  breadcrumb.addEventListener('drop', (event) => {
    if (!isCardDrag(event.dataTransfer)) return
    const crumb = event.target.closest('[data-folder-crumb]')
    if (!crumb) return
    event.preventDefault()
    event.stopPropagation()
    const target = crumb.dataset.folderCrumb
    void dropCardIntoFolder(event.dataTransfer, target === 'root' ? null : target)
  })

  // 排序
  $('#sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value
    state.page = 1
    refresh()
  })

  // 搜索（防抖）
  let searchTimer
  $('#search-input').addEventListener('input', (event) => {
    const value = event.target.value.trim()
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.query = value
      state.page = 1
      refresh()
    }, 220)
  })

  // 上传入口
  const input = $('#file-input')
  const triggerPick = () => input.click()
  $('#upload-btn').addEventListener('click', triggerPick)
  $('#upload-btn-mobile').addEventListener('click', triggerPick)
  input.addEventListener('change', async () => {
    const files = input.files
    await uploadFiles(files)
    input.value = ''
  })

  // 分页
  $('#page-prev').addEventListener('click', () => { void goToPage(state.page - 1) })
  $('#page-next').addEventListener('click', () => { void goToPage(state.page + 1) })
  $('#page-numbers').addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]')
    if (button) void goToPage(Number(button.dataset.page))
  })

  // 拖拽上传
  let dragDepth = 0
  let lastDropSignature = ''
  let lastDropAt = 0
  const overlay = $('#drop-overlay')
  window.addEventListener('dragenter', (event) => {
    if (!state.user || !isExternalFileDrag(event.dataTransfer)) return
    dragDepth += 1
    overlay.hidden = false
  })
  window.addEventListener('dragover', (event) => {
    if (overlay.hidden || !isExternalFileDrag(event.dataTransfer)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) overlay.hidden = true
  })
  window.addEventListener('drop', async (event) => {
    if (!state.user) return
    const transfer = event.dataTransfer
    const hasFiles = Boolean(transfer && Array.from(transfer.types || []).includes('Files'))

    // 页面内部拖拽：阻止浏览器默认打开文件，但绝不触发上传
    if (!isExternalFileDrag(transfer)) {
      if (hasFiles) event.preventDefault()
      dragDepth = 0
      overlay.hidden = true
      markInternalDragEnd()
      return
    }

    event.preventDefault()
    dragDepth = 0
    overlay.hidden = true

    // 同一批里名称、大小、修改时间、MIME 完全相同的文件只上传一次
    const files = uniqueFiles(transfer && transfer.files)
    if (!files.length) {
      markInternalDragEnd()
      return
    }

    // 某些浏览器 / 输入设备可能把一次 drop 派发两次，短时间内按内容签名去重
    const signature = files.map(fileSignature).join('|')
    const now = Date.now()
    if (signature === lastDropSignature && now - lastDropAt < 1200) {
      markInternalDragEnd()
      return
    }
    lastDropSignature = signature
    lastDropAt = now

    await uploadFiles(files)
    markInternalDragEnd()
  })

  // 卡片拖拽用于移动，和从桌面拖入上传必须明确区分，避免同一张图片被重复上传。
  document.addEventListener('dragstart', (event) => {
    const target = event.target
    const card = target && target.closest ? target.closest('.card[data-drag-kind]') : null
    if (card && card.draggable) {
      const kind = card.dataset.dragKind
      const id = kind === 'folder' ? card.dataset.folderId : card.dataset.id
      if (kind && id && event.dataTransfer) {
        markInternalDragStart()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(CARD_DRAG_MIME, JSON.stringify({ kind, id }))
        return
      }
    }

    // 只有不在可拖卡片里的图片 / 视频才禁止拖起，否则缩略图会成为拖拽目标。
    const tag = target && target.tagName
    if (tag === 'IMG' || tag === 'VIDEO') {
      event.preventDefault()
      markInternalDragEnd()
    }
  }, true)
  document.addEventListener('dragend', () => {
    clearDropTargets()
    markInternalDragEnd()
  }, true)

  // 卡片交互（事件委托）
  const grid = $('#file-grid')
  grid.addEventListener('dragover', (event) => {
    if (!isCardDrag(event.dataTransfer)) return
    const folderCard = event.target.closest('.folder-card[data-folder-id]:not(.is-in-trash)')
    if (!folderCard) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    if (!folderCard.classList.contains('is-drop-target')) {
      clearDropTargets()
      folderCard.classList.add('is-drop-target')
    }
  })
  grid.addEventListener('dragleave', (event) => {
    const folderCard = event.target.closest('.folder-card[data-folder-id]:not(.is-in-trash)')
    if (!folderCard) return
    if (!(event.relatedTarget instanceof Node) || !folderCard.contains(event.relatedTarget)) {
      folderCard.classList.remove('is-drop-target')
    }
  })
  grid.addEventListener('drop', (event) => {
    if (!isCardDrag(event.dataTransfer)) return
    const folderCard = event.target.closest('.folder-card[data-folder-id]:not(.is-in-trash)')
    if (!folderCard) return
    event.preventDefault()
    event.stopPropagation()
    void dropCardIntoFolder(event.dataTransfer, folderCard.dataset.folderId)
  })
  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.card')
    if (!card) return
    const folderCard = event.target.closest('.folder-card')
    if (folderCard) {
      const folderId = folderCard.dataset.folderId
      const more = event.target.closest('[data-more]')
      if (more) {
        event.stopPropagation()
        openCardMenu(more, 'folder', folderId)
        return
      }
      if (event.target.closest('[data-folder-rename]')) openRenameDialog('folder', folderId)
      else if (event.target.closest('[data-folder-delete]')) deleteFolder(folderId)
      else if (event.target.closest('[data-folder-restore]')) restoreFolder(folderId)
      else if (event.target.closest('[data-folder-purge]')) purgeFolder(folderId)
      else if (event.target.closest('[data-folder-download]')) {
        event.preventDefault()
        const folder = state.folders.find((item) => item.id === folderId)
        if (folder && window.VaultTransfers) void window.VaultTransfers.startFolderDownload(folder)
      } else if (event.target.closest('[data-folder-open]')) openFolder(folderId)
      return
    }
    const more = event.target.closest('[data-more]')
    if (more) {
      event.stopPropagation()
      openCardMenu(more, 'file', card.dataset.id)
      return
    }
    const downloadLink = event.target.closest('[data-download]')
    if (downloadLink) {
      event.preventDefault()
      const record = state.files.find((row) => row.id === card.dataset.id)
      if (record && window.VaultTransfers) void window.VaultTransfers.startDownload(record)
      return
    }
    if (event.target.closest('[data-rename-file]')) {
      openRenameDialog('file', card.dataset.id)
      return
    }
    if (event.target.closest('[data-move]')) {
      void openMoveDialog('file', card.dataset.id)
      return
    }
    if (event.target.closest('[data-private]')) {
      moveToPrivacy(card.dataset.id)
      return
    }
    if (event.target.closest('[data-unprivate]')) {
      moveOutOfPrivacy(card.dataset.id)
      return
    }
    if (event.target.closest('[data-private-delete]')) {
      deletePrivateFile(card.dataset.id)
      return
    }
    if (event.target.closest('[data-delete]')) {
      deleteFile(card.dataset.id)
      return
    }
    if (event.target.closest('[data-restore]')) {
      restoreFile(card.dataset.id)
      return
    }
    if (event.target.closest('[data-purge]')) {
      purgeFile(card.dataset.id)
      return
    }
    if (event.target.closest('[data-no-open]')) return
    if (event.target.closest('[data-open]')) openLightbox(card.dataset.id)
  })
  grid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const card = event.target.closest('.card')
    if (!card) return
    event.preventDefault()
    if (card.classList.contains('folder-card')) {
      if (card.dataset.folderId && !card.classList.contains('is-in-trash')) openFolder(card.dataset.folderId)
      return
    }
    openLightbox(card.dataset.id)
  })

  // 灯箱
  $('#lightbox').addEventListener('click', (event) => {
    if (event.target.closest('#lightbox-download')) {
      event.preventDefault()
      const record = state.files.find((row) => row.id === state.lightboxId)
      if (record && window.VaultTransfers) void window.VaultTransfers.startDownload(record)
      return
    }
    if (event.target.closest('[data-close]')) closeLightbox()
  })
  $('#lightbox-prev').addEventListener('click', () => navigateLightbox(-1))
  $('#lightbox-next').addEventListener('click', () => navigateLightbox(1))
  $('#video-quality').addEventListener('change', (event) => {
    const record = state.files.find((row) => row.id === state.lightboxId)
    if (record && record.category === 'video') applyVideoQuality(record, event.target.value)
  })
  $('#lightbox-restore').addEventListener('click', () => {
    if (state.lightboxId) restoreFile(state.lightboxId)
  })
  $('#lightbox-private').addEventListener('click', () => {
    if (!state.lightboxId) return
    const record = state.files.find((row) => row.id === state.lightboxId)
    if (!record) return
    if (record.isPrivate) moveOutOfPrivacy(record.id)
    else moveToPrivacy(record.id)
  })
  $('#lightbox-delete').addEventListener('click', () => {
    if (!state.lightboxId) return
    const record = state.files.find((row) => row.id === state.lightboxId)
    if (!record) return
    // 隐私空间内的删除是永久删除；回收站内也是永久删除；普通文件则先进入回收站。
    if (record.isPrivate) deletePrivateFile(record.id)
    else if (state.trash) purgeFile(record.id)
    else deleteFile(record.id)
  })

  $('#card-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-card-menu-action]')
    if (item) runCardMenuAction(item.dataset.cardMenuAction)
  })
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#card-menu') && !event.target.closest('[data-more]')) closeCardMenu()
  }, true)
  window.addEventListener('scroll', closeCardMenu, true)
  window.addEventListener('resize', closeCardMenu)

  // 弹窗关闭
  $('#password-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) $('#password-modal').hidden = true
  })
  $('#move-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-move-close]')) closeMoveDialog()
  })
  $('#move-form').addEventListener('submit', (event) => { void submitMove(event) })
  $('#rename-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-rename-close]')) closeRenameDialog()
  })
  $('#rename-form').addEventListener('submit', (event) => { void submitRename(event) })

  document.addEventListener('keydown', (event) => {
    if (!$('#lightbox').hidden && zoom.el) {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomTo(zoom.scale * 1.25)
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomTo(zoom.scale / 1.25)
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        zoomTo(1)
        return
      }

      // 高倍缩放时也可以用方向键平移，每次移动预览区的 12%
      if (zoom.scale > 1 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault()
        const step = Math.max(40, (zoom.stage ? zoom.stage.clientWidth : 600) * 0.12)
        if (event.key === 'ArrowLeft') zoom.x -= step
        if (event.key === 'ArrowRight') zoom.x += step
        if (event.key === 'ArrowUp') zoom.y -= step
        if (event.key === 'ArrowDown') zoom.y += step
        applyZoom()
        return
      }
    }

    if (!$('#lightbox').hidden && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const target = event.target
      const editing = target && target.closest && target.closest('input, textarea, select, audio, video, [contenteditable="true"]')
      if (!editing) {
        event.preventDefault()
        navigateLightbox(event.key === 'ArrowLeft' ? -1 : 1)
        return
      }
    }

    if (event.key === 'Tab') {
      const overlay = !$('#privacy-modal').hidden
        ? $('#privacy-modal')
        : (! $('#password-modal').hidden ? $('#password-modal') : (!$('#lightbox').hidden ? $('#lightbox') : null))
      if (overlay) {
        const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', overlay)
          .filter((node) => !node.hidden && node.getClientRects().length > 0)
        if (focusable.length) {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (event.shiftKey && (active === first || !overlay.contains(active))) {
            event.preventDefault()
            last.focus()
            return
          }
          if (!event.shiftKey && (active === last || !overlay.contains(active))) {
            event.preventDefault()
            first.focus()
            return
          }
        }
      }
    }
    if (event.key !== 'Escape') return
    if (!$('#card-menu').hidden) closeCardMenu()
    else if (!$('#privacy-modal').hidden) closePrivacyAuthDialog(false)
    else if (!$('#move-modal').hidden) closeMoveDialog()
    else if (!$('#rename-modal').hidden) closeRenameDialog()
    else if (!$('#lightbox').hidden) closeLightbox()
    else if (!$('#password-modal').hidden) $('#password-modal').hidden = true
    else if (!$('#user-dropdown').hidden) $('#user-dropdown').hidden = true
  })

  // 窗口尺寸变化后重新套用缩放边界；窄屏视频只保留元数据预加载，减少流量占用
  window.addEventListener('resize', () => {
    if (zoom.el) applyZoom()
    const video = $('#lightbox-body video')
    if (video && window.innerWidth < 720) video.setAttribute('preload', 'metadata')
  })

  // 浏览器从前进 / 后退缓存恢复页面时也视为一次重新进入，必须再次解锁。
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && state.privacyUnlocked) {
      void lockPrivacySpace({ switchToAll: state.privacyMode })
    }
  })
}

/* ───────────────────────────── 启动 ───────────────────────────── */

/**
 * 询问服务端：注册需不需要注册码？
 *
 * 为什么要问？因为注册码配在服务器的 config.json 里，
 * 前端没法提前知道自己该不该显示那个输入框。
 * 注意服务端只返回一个布尔值，不会把注册码本身发给前端。
 *
 * 不需要时把整个字段隐藏掉 —— 而不是显示一个空框让用户困惑。
 */
async function loadAuthConfig() {
  try {
    const config = await api('/api/auth/config')
    state.requireRegistrationCode = Boolean(config.requireRegistrationCode)

    const field = $('#registration-field')
    const input = $('#register-form [name="registrationCode"]')

    field.hidden = !state.requireRegistrationCode
    // 需要时设成必填，让浏览器先拦一道，省一次网络往返
    if (input) input.required = state.requireRegistrationCode
  } catch {
    // 拿不到配置就按「不需要」处理，别把注册整个卡死
    state.requireRegistrationCode = false
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  启动流程 —— 页面加载后执行的第一段逻辑
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 【为什么叫 boot】
 *   boot 是「引导启动」的意思，和 bootstrap 同源 —— 指系统开机时
 *   先跑的那段把一切都准备好代码。
 *
 * 【为什么不直接在服务器上渲染好页面】
 *   那样服务器每次都要拼 HTML，而且换一个客户端（手机 App、小程序）
 *   就得重写一遍。现在服务器只给数据（JSON），
 *   谁来拿、拿去做成什么样，都由各自的前端决定 —— 这就是前后端分离的意义。
 *
 * 【这个函数做的事】
 *   1. 写入前端版本号并绑定认证 / 主界面事件
 *   2. 并行读取注册策略
 *   3. 查询当前登录用户，成功后清除旧隐私解锁并加载第一页文件
 *   4. 未登录或会话失效时显示登录页
 */
async function loadAppVersion() {
  try {
    const { version } = await api('/api/meta')
    const label = version ? `v${version}` : 'v—'
    $('#app-version').textContent = label
    $('#auth-version').textContent = label
  } catch {
    $('#app-version').textContent = 'v—'
    $('#auth-version').textContent = 'v—'
  }
}
async function boot() {
  // 版本号以 package.json 为唯一来源，由服务端公开接口提供。
  void loadAppVersion()
  applySiteFooter()

  // 先挂监听器。这样即使用户在数据还没加载完时就点击，也能正常响应。
  bindAuth()   // 登录/注册表单、用户菜单、修改密码弹窗
  bindApp()    // 分类切换、搜索、排序、上传、卡片点击、快捷键

  // 并行去问注册策略，不 await —— 不阻塞「我登录了吗」的判断
  loadAuthConfig()

  try {
    /**
     * 问服务器「当前是谁」。
     * 浏览器会自动带上之前登录时存的 Cookie，所以：
     *   有有效 Cookie  → 返回用户信息
     *   没有或已过期   → 返回 401，api() 会抛出异常
     * 这里用 try/catch 把「401」当作正常分支来处理（就是没登录而已）。
     */
    const { user } = await api('/api/auth/me')
    state.user = user
    // 刷新 / 重新打开页面后必须重新输入隐私密码。锁定与主界面、普通文件列表
    // 可以并行执行；真正进入隐私空间时 requestPrivacyUnlock() 会等待锁定完成。
    privacyReloadLockPromise = api('/api/privacy/lock', { method: 'POST' })
      .catch(() => {})
      .finally(() => { privacyReloadLockPromise = null })
    showApp()
    await window.VaultTransfers?.restore()
    await refresh()   // 登录状态确认后，才去加载文件列表
    await privacyReloadLockPromise
  } catch (error) {
    showAuth()
    if (!error || error.status !== 401) {
      notify((error && error.message) || '无法加载账号状态，请稍后重试')
    }
  }
}

// 最后一行执行启动。
// 因为 <script> 标签放在 </body> 前面，此时页面元素都已存在，可以直接操作。
boot()
