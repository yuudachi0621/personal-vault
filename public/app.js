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
       3. 后端从 files.json 里挑出该用户的照片，返回 JSON
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
     通用工具 → Toast 提示 → 视图切换 → 认证 → 列表渲染
     → 数据加载 → 上传 → 图片缩放 → 音乐播放器 → 灯箱 → 事件绑定 → 启动
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
  usage: null,       // 用量统计（总数、总大小、各分类数量）
  category: 'all',   // 当前选中的分类
  query: '',         // 搜索关键词
  sort: 'newest',    // 排序方式
  lightboxId: null,  // 灯箱里正在看哪个文件
  lightboxNavigating: false, // 是否正在为灯箱加载下一页
  total: 0,          // 当前筛选条件下共有多少条（由服务器告知）
  hasMore: false,    // 是否还有下一页
  loadingMore: false, // 是否正在加载下一页
  requireRegistrationCode: false, // 服务端是否要求注册码（决定要不要显示那个输入框）
  trash: false,      // 是否处于回收站视图
  ttlMs: 24 * 60 * 60 * 1000, // 回收站保留时长（由服务器下发，前端只用来算倒计时）
  videoQuality: '720p', // 视频播放清晰度：720p / original
}

/**
 * 每页加载多少条。
 *
 * 【为什么要分页】
 *   之前是一次把全部文件要回来。文件攒到几千个以后，
 *   一次响应几百 KB，浏览器还要一次性建出几千个卡片节点，
 *   页面会明显卡顿。更糟的是每个卡片都会去请求缩略图，
 *   服务器瞬间被打出上百个并发连接，小内存机器直接扛不住。
 *   现在一次只拿 60 条，滚动到底再点「加载更多」。
 */
const PAGE_SIZE = 60
const VIDEO_QUALITY_KEY = 'personal-vault:video-quality'
try {
  const savedQuality = localStorage.getItem(VIDEO_QUALITY_KEY)
  if (['720p', 'original'].includes(savedQuality)) state.videoQuality = savedQuality
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
 * 页面内部是否正在拖拽。
 *
 * 只看 dataTransfer.types 并不够：浏览器把页面里的图片拖起来时也可能只暴露
 * 'Files'，和从桌面拖入文件无法区分，这正是「拖一下图片就多传一份」的来源。
 * 因此从 dragstart 开始明确标记来源，直到 dragend / drop 才解除。
 */
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
const APP_VERSION = '1.6.1'

async function api(path, options = {}) {
  /**
   * fetch 发起 HTTP 请求。两个要点：
   *   credentials: 'include' —— 让浏览器带上 Cookie。
   *     不带的话服务器认不出你是谁，所有需要登录的接口都会返回 401。
   *     这个值同时适用同源与跨域两种部署形态。
   *   ...options 展开 —— 把调用方传进来的 method / headers / body 合进来。
   *     如果 options 里也有 credentials，会覆盖上面的默认值。
   */
  const res = await fetch(apiUrl(path), { credentials: 'include', ...options })

  // 先尝试把响应解析成 JSON。有些错误响应可能不是 JSON（比如网关返回的 HTML），
  // 所以包一层 try，解析失败就让 body 保持 null，不至于整个函数崩掉。
  let body = null
  try {
    body = await res.json()
  } catch {
    /* 非 JSON 响应 */
  }

  /**
   * res.ok 是浏览器提供的便捷属性：状态码在 200~299 之间时为 true。
   *
   * 这里的关键设计：把「失败」变成「抛异常」。
   * 于是调用方可以统一写成 try/catch，不用每次都判断 res.ok。
   * 而且把后端的错误码和错误信息挂在 error 对象上，
   * 调用方就能区分「没登录（401）」和「其它失败」。
   */
  if (!res.ok) {
    const error = new Error((body && body.error) || `请求失败（${res.status}）`)
    error.status = res.status
    error.code = body && body.code
    throw error
  }

  return body
}

/* ───────────────────────────── Toast ───────────────────────────── */

function createToast({ title, sub = '', kind = '' }) {
  const el = document.createElement('div')
  el.className = `toast${kind ? ` is-${kind}` : ''}`
  el.innerHTML = `
    <div class="toast-head"><span class="dot"></span><span class="toast-name"></span></div>
    ${sub ? '<div class="toast-sub"></div>' : ''}
    <div class="toast-track"><i></i></div>`
  $('.toast-name', el).textContent = title
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
  state.user = null
  state.files = []
  clearPreviewPreloads()
  // 分页状态也要重置，否则换账号登录后会接着上一个人的「已加载数量」往下取
  state.total = 0
  state.hasMore = false
  state.loadingMore = false
  state.trash = false
  $('#app-view').hidden = true
  $('#auth-view').hidden = false
  $('#load-more-wrap').hidden = true
  closeLightbox()
  $('#password-modal').hidden = true
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
  $('#dropdown-name').textContent = name
  $('#dropdown-mail').textContent = state.user.email
}

/* ───────────────────────────── 认证 ───────────────────────────── */

function bindAuth() {
  $$('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.authTab
      $$('[data-auth-tab]').forEach((b) => b.classList.toggle('is-active', b === btn))
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

function cardHtml(record) {
  const raw = apiUrl(`/api/files/${record.id}/raw`)
  const inTrash = Boolean(record.deletedAt)

  let thumb
  if (record.category === 'image') {
    thumb = `<img src="${raw}" alt="${escapeHtml(record.name)}" loading="lazy" decoding="async" draggable="false">`
  } else if (record.category === 'video') {
    thumb = `<video src="${raw}#t=0.5" preload="metadata" muted playsinline draggable="false"></video>
      <div class="card-play"><span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg></span></div>`
  } else if (record.category === 'music') {
    thumb = musicGlyph(record)
  } else {
    thumb = fileGlyph(record)
  }

  // 回收站里的卡片：角标显示倒计时，操作换成「恢复 / 彻底删除」
  const badge = inTrash
    ? `<span class="card-badge is-trash" data-cat="trash"><i></i>${escapeHtml(trashRemainText(record))}</span>`
    : `<span class="card-badge" data-cat="${record.category}"><i></i>${CATEGORY_LABEL[record.category]}</span>`

  const actions = inTrash
    ? `<button type="button" title="恢复" aria-label="恢复" data-restore data-no-open>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a8 8 0 1 1 2.3 7"/><path d="M4 5v5h5"/></svg>
        </button>
        <button type="button" title="彻底删除" aria-label="彻底删除" data-purge data-no-open>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 11a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-11"/></svg>
        </button>`
    : `<a href="${apiUrl(`/api/files/${record.id}/download`)}" title="下载" aria-label="下载" data-no-open>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg>
        </a>
        <button type="button" title="删除" aria-label="删除" data-delete data-no-open>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 11a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-11"/></svg>
        </button>`

  return `<article class="card${inTrash ? ' is-in-trash' : ''}" data-id="${record.id}" tabindex="0">
    <div class="card-thumb" data-open>
      ${badge}
      <div class="card-actions">${actions}</div>
      ${thumb}
    </div>
    <div class="card-body">
      <div class="card-name" title="${escapeHtml(record.name)}">${escapeHtml(record.name)}</div>
      <div class="card-meta">${formatSize(record.size)} · ${formatDate(record.createdAt)}</div>
    </div>
  </article>`
}

function renderGrid() {
  const grid = $('#file-grid')
  const empty = $('#empty-state')
  const count = $('#view-count')
  const title = $('#view-title')

  // 回收站是独立视图，标题和分类无关
  title.textContent = state.trash ? '回收站' : CATEGORY_LABEL[state.category]
  // 显示的是「总数」，不是「已加载数」—— 用户关心的是这里到底有多少东西
  count.textContent = `${state.total} 项`
  $('#trash-banner').hidden = !state.trash

  if (!state.files.length) {
    grid.innerHTML = ''
    empty.hidden = false
    const searching = Boolean(state.query)

    if (state.trash) {
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
  grid.innerHTML = state.files.map(cardHtml).join('')
  $$('.card', grid).forEach((card, index) => {
    card.style.animationDelay = `${Math.min(index * 22, 260)}ms`
  })
}

function renderUsage() {
  const usage = state.usage
  if (!usage) return

  const activeBytes = usage.bytes || 0
  const trashBytes = (usage.trash && usage.trash.bytes) || 0
  const totalBytes = Number.isFinite(usage.totalBytes)
    ? usage.totalBytes
    : activeBytes + trashBytes

  // 存储用量显示实际占用：正常文件 + 回收站文件，与上传配额的计算一致
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

/**
 * 从后端拉取文件列表并刷新界面。这是整个页面最核心的一个函数 ——
 * 切换分类、搜索、排序、上传完、删除后，全都会调用它。
 *
 * 它体现了前端最常用的思路：
 *   改状态 → 请求数据 → 重新渲染
 * 而不是「手动去改某一行 DOM」。因为每次都整体重画，
 * 界面显示的内容永远和数据一致，不会出现改了一处忘了另一处的情况。
 *
 * @param {boolean} silent 为 true 时不显示骨架屏（用于上传完成后的静默刷新，
 *                         避免界面闪一下影响体验）
 */
/** 组装列表请求的参数（筛选、排序、分页一起带上）。 */
function buildListParams(offset) {
  /**
   * URLSearchParams 用来安全地拼查询参数。
   * 它会自动处理中文和特殊字符的编码 ——
   * 如果自己拿字符串拼，关键词里的中文会导致服务器返回 400。
   */
  const params = new URLSearchParams()
  if (state.category !== 'all') params.set('category', state.category)
  if (state.query) params.set('q', state.query)
  params.set('sort', state.sort)
  params.set('limit', String(PAGE_SIZE))
  params.set('offset', String(offset))
  return params
}

/** 更新底部「加载更多」区域的显示。 */
function renderLoadMore() {
  const wrap = $('#load-more-wrap')
  const btn = $('#load-more-btn')
  const hint = $('#load-more-hint')

  // 已经全部加载完了就不显示这个区域，界面更干净
  if (!state.hasMore) {
    wrap.hidden = true
    return
  }

  wrap.hidden = false
  btn.disabled = state.loadingMore
  btn.textContent = state.loadingMore ? '加载中…' : '加载更多'
  hint.textContent = `已显示 ${state.files.length} / ${state.total}`
}

/**
 * 按当前视图取一页数据。
 *
 * 正常列表和回收站是两个不同接口，但返回结构一致（files / usage / page），
 * 所以在这里统一成同一个函数，上面的渲染逻辑完全不用关心数据来自哪。
 */
async function fetchPage(offset) {
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
 * 加载第一页，并重置列表。切换分类、搜索、排序、上传完成都会走这里。
 *
 * 它体现了前端最常用的思路：
 *   改状态 → 请求数据 → 重新渲染
 * 而不是「手动去改某一行 DOM」。因为每次都整体重画，
 * 界面显示的内容永远和数据一致。
 *
 * @param {boolean} silent 为 true 时不显示骨架屏（用于上传后的静默刷新，
 *                         避免界面闪一下影响体验）
 */
async function refresh({ silent = false } = {}) {
  const skeleton = $('#skeleton')

  // 首次加载（列表还是空的）时显示骨架屏占位，让用户知道正在加载
  if (!silent && !state.files.length) {
    skeleton.hidden = false
    $('#file-grid').innerHTML = ''
    $('#empty-state').hidden = true
  }

  try {
    // 筛选和排序都由后端做（数据在服务器那边），前端只负责把条件传过去
    const data = await fetchPage(0)

    // 存进状态，再据此重新渲染
    state.files = data.files
    state.usage = data.usage
    state.total = data.page.total
    state.hasMore = data.page.hasMore

    renderGrid()    // 画文件网格
    renderUsage()   // 画侧栏的用量统计
    renderLoadMore() // 更新「加载更多」按钮
  } catch (error) {
    /**
     * 401 表示登录已失效（比如令牌过期，或 Cookie 被清了）。
     * 这种情况不该弹错误提示，而应该直接退回到登录页让用户重新登录。
     */
    if (error.status === 401) {
      showAuth()
      return
    }
    notify(error.message)
  } finally {
    // finally 里的代码无论成功失败都会执行，适合放「收尾」动作
    skeleton.hidden = true
  }
}

/**
 * 加载下一页，追加到现有列表后面。
 *
 * 注意这里用「追加」而不是「重画全部」：
 *   重画会让已经加载好的图片全部重新请求，滚动位置也会跳。
 *   追加只处理新增的那 60 条，体验流畅得多。
 */
async function loadMore() {
  // 正在加载、或者已经没有更多了，就直接忽略（防止连点重复请求）
  if (state.loadingMore || !state.hasMore) return

  state.loadingMore = true
  renderLoadMore()

  try {
    // offset = 已加载数量，正好接在上一页后面
    const data = await fetchPage(state.files.length)

    state.files = state.files.concat(data.files)
    state.usage = data.usage
    state.total = data.page.total
    state.hasMore = data.page.hasMore

    // insertAdjacentHTML 把新卡片的 HTML 直接塞到网格末尾，不破坏已有的 DOM
    $('#file-grid').insertAdjacentHTML('beforeend', data.files.map(cardHtml).join(''))
  } catch (error) {
    if (error.status === 401) {
      showAuth()
      return
    }
    notify(error.message)
  } finally {
    state.loadingMore = false
    renderLoadMore()
  }
}

/* ───────────────────────────── 上传 ───────────────────────────── */

/**
 * 上传单个文件。
 *
 * 【为什么不用 fetch，改用老式的 XMLHttpRequest】
 *   上传大文件要给用户看进度条。fetch 直到传完才告诉你结果，
 *   中间没有「传了多少」的回调；XMLHttpRequest 有 upload.onprogress 事件，
 *   所以这里必须用老 API。
 *
 * 【请求体直接就是文件本身】
 *   注意 xhr.send(file)：把 File 对象直接当请求体发出去，
 *   没有任何表单包装。文件名和分类放在 URL 查询参数里。
 *   后端因此可以「拿到多少写多少」，不用先解析格式。
 *
 * 用 Promise 包住是为了能在外面写 `await uploadOne(...)`，
 * 把回调式的写法转成顺序式的写法。
 */
function uploadOne(file) {
  return new Promise((resolve) => {
    // 文件名要经过 URLSearchParams 编码，否则中文名会让服务器返回 400。
    // 分类由服务端按 MIME / 扩展名判断，避免受当前浏览分类影响。
    const params = new URLSearchParams({ name: file.name })

    // 先弹一个 0% 的进度条，后面随上传实时更新
    const toast = createToast({ title: file.name, sub: `0% · ${formatSize(file.size)}` })

    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(`/api/files/upload?${params.toString()}`))

    // 让这次请求带上 Cookie（相当于 fetch 的 credentials: 'include'）
    xhr.withCredentials = true

    // 告诉服务器这是什么类型的文件，后端据此判断它属于照片/视频/普通文件
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')

    /**
     * 上传进度事件。
     * lengthComputable 表示「总大小已知」——只有知道总量才能算出百分比。
     * event.loaded 是已发送字节数，event.total 是总字节数。
     */
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return
      const ratio = event.loaded / event.total
      toast.progress(ratio)
      toast.setSub(`${Math.round(ratio * 100)}% · ${formatSize(file.size)}`)
    })

    // 请求成功返回（注意：这里指「网络层面成功」，状态码可能是 4xx/5xx）
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // 成功提示里带上服务端最终判定的分类，避免用户误以为分类取决于当前页面
        let categoryText = ''
        try {
          const body = JSON.parse(xhr.responseText)
          if (body && body.file && CATEGORY_LABEL[body.file.category]) {
            categoryText = `${CATEGORY_LABEL[body.file.category]} · `
          }
        } catch {
          /* 响应异常不影响上传成功状态 */
        }
        toast.succeed(`已上传 · ${categoryText}${formatSize(file.size)}`)
        resolve(true)
        return
      }
      // 状态码不在 2xx 范围内，说明后端拒绝了，尝试读出它给的原因
      let message = `上传失败（${xhr.status}）`
      try {
        const body = JSON.parse(xhr.responseText)
        if (body && body.error) message = body.error
      } catch {
        /* 响应不是 JSON，就用上面的通用提示 */
      }
      toast.fail(message)
      if (xhr.status === 401) showAuth()   // 登录失效，退回登录页
      resolve(false)
    })

    // 网络层面就失败了（断网、服务器没起来）
    xhr.addEventListener('error', () => {
      toast.fail('网络异常，上传中断')
      resolve(false)
    })
    xhr.addEventListener('abort', () => {
      toast.fail('上传已取消')
      resolve(false)
    })

    xhr.send(file)   // 真正开始发送
  })
}

// 正在上传的文件：即使同一个文件被连续拖入两次，也不会并发上传两份。
const activeUploadKeys = new Set()

async function uploadFiles(fileList) {
  const files = uniqueFiles(fileList)
  if (!files.length) return

  const accepted = files.filter((file) => !activeUploadKeys.has(fileSignature(file)))
  if (!accepted.length) return

  const keys = accepted.map(fileSignature)
  keys.forEach((key) => activeUploadKeys.add(key))

  try {
    const results = await Promise.all(accepted.map((file) => uploadOne(file)))
    if (results.some(Boolean)) await refresh({ silent: true })
  } finally {
    keys.forEach((key) => activeUploadKeys.delete(key))
  }
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
 * 给灯箱里的图片挂上缩放交互：
 *   滚轮      缩放（以指针为锚点）
 *   双击      在 1x 与 2.5x 之间切换
 *   拖动      放大后拖拽平移
 *   双指捏合  触屏缩放
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
  prev.disabled = index <= 0 || state.lightboxNavigating
  next.disabled = state.lightboxNavigating || index < 0 || (index >= state.files.length - 1 && !state.hasMore)
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

/** 预热相邻照片；相邻视频只预取 metadata，避免提前下载大量视频流量。 */
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

/** 查询 720P 播放副本是否已经生成。 */
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

/** 切换清晰度时保留当前播放时间和播放/暂停状态。 */
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

/** 视频缓冲或定位时给出明确状态，并在长时间卡住后自动重连一次。 */
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

/** 按当前筛选和排序顺序切换上一个 / 下一个文件。 */
async function navigateLightbox(direction) {
  if (!state.lightboxId || state.lightboxNavigating) return
  let index = lightboxRecordIndex()
  if (index < 0) return

  if (direction > 0 && index >= state.files.length - 1 && state.hasMore) {
    const expectedId = state.lightboxId
    state.lightboxNavigating = true
    updateLightboxNavigation()
    try {
      await loadMore()
    } finally {
      state.lightboxNavigating = false
    }
    if (state.lightboxId !== expectedId) return
  }

  index = lightboxRecordIndex()
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= state.files.length) {
    updateLightboxNavigation()
    return
  }
  openLightbox(state.files[targetIndex].id)
}

function openLightbox(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return
  pauseLightboxMedia()
  state.lightboxId = id

  const raw = apiUrl(`/api/files/${record.id}/raw`)
  const inTrash = Boolean(record.deletedAt)
  const index = lightboxRecordIndex(id)
  const position = state.total > 1 && index >= 0 ? ` · ${index + 1} / ${state.total}` : ''
  const summary = inTrash
    ? `${CATEGORY_LABEL[record.category]} · ${formatSize(record.size)} · ${trashRemainText(record)}`
    : `${CATEGORY_LABEL[record.category]} · ${formatSize(record.size)} · ${formatDate(record.createdAt)}`

  $('#lightbox-name').textContent = record.name
  $('#lightbox-sub').textContent = `${summary}${position}`
  $('#lightbox-download').href = apiUrl(`/api/files/${record.id}/download`)

  // 回收站里：显示「恢复」，删除按钮改成「彻底删除」
  $('#lightbox-restore').hidden = !inTrash
  $('#lightbox-delete').textContent = inTrash ? '彻底删除' : '删除'
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
async function deleteFile(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return
  if (!window.confirm(`把「${record.name}」移到回收站？\n\n24 小时内可以恢复，之后会自动清除。`)) return

  try {
    await api(`/api/files/${id}`, { method: 'DELETE' })
    if (state.lightboxId === id) closeLightbox()
    notify(`已移入回收站：${record.name}`, 'ok')
    // 删除后直接展示回收站，用户可以立刻确认文件确实在里面，也能马上恢复
    await openTrashView({ silent: true })
  } catch (error) {
    notify(error.message)
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
  $('#cat-list').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-cat]')
    if (!btn) return
    state.category = btn.dataset.cat
    state.trash = false                       // 从回收站切回普通列表
    $('#trash-btn').classList.remove('is-active')
    $$('#cat-list .cat-item').forEach((item) => item.classList.toggle('is-active', item === btn))
    refresh()
  })

  // 回收站入口：独立视图，进去时清空搜索词，避免带着别的条件看
  $('#trash-btn').addEventListener('click', () => openTrashView())

  $('#empty-trash-btn').addEventListener('click', emptyTrash)

  // 图片缩放按钮
  $('#zoom-in').addEventListener('click', () => zoomTo(zoom.scale * 1.3))
  $('#zoom-out').addEventListener('click', () => zoomTo(zoom.scale / 1.3))
  $('#zoom-reset').addEventListener('click', () => zoomTo(1))

  // 排序
  $('#sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value
    refresh()
  })

  // 搜索（防抖）
  let searchTimer
  $('#search-input').addEventListener('input', (event) => {
    const value = event.target.value.trim()
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.query = value
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

  // 加载更多
  $('#load-more-btn').addEventListener('click', loadMore)

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

  // dragstart 明确标记「页面内部拖拽」；图片 / 视频本身则直接禁止拖起
  document.addEventListener('dragstart', (event) => {
    markInternalDragStart()
    const tag = event.target && event.target.tagName
    if (tag === 'IMG' || tag === 'VIDEO') {
      event.preventDefault()
      markInternalDragEnd()
    }
  }, true)
  document.addEventListener('dragend', markInternalDragEnd, true)

  // 卡片交互（事件委托）
  const grid = $('#file-grid')
  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.card')
    if (!card) return
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
    openLightbox(card.dataset.id)
  })

  // 灯箱
  $('#lightbox').addEventListener('click', (event) => {
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
  $('#lightbox-delete').addEventListener('click', () => {
    if (!state.lightboxId) return
    // 在回收站里看到的是「彻底删除」，在普通列表里是「移入回收站」
    if (state.trash) purgeFile(state.lightboxId)
    else deleteFile(state.lightboxId)
  })

  // 弹窗关闭
  $('#password-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) $('#password-modal').hidden = true
  })

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

    if (event.key !== 'Escape') return
    if (!$('#lightbox').hidden) closeLightbox()
    else if (!$('#password-modal').hidden) $('#password-modal').hidden = true
    else if (!$('#user-dropdown').hidden) $('#user-dropdown').hidden = true
  })

  // 窗口尺寸变化后重新套用缩放边界；窄屏视频只保留元数据预加载，减少流量占用
  window.addEventListener('resize', () => {
    if (zoom.el) applyZoom()
    const video = $('#lightbox-body video')
    if (video && window.innerWidth < 720) video.setAttribute('preload', 'metadata')
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
 * 【这个函数做了三件事】
 *   1. 给所有按钮和输入框挂上事件监听器
 *   2. 问服务器「我现在登录着吗」
 *   3. 根据回答决定显示登录页还是主界面
 */
async function boot() {
  // 把前端版本号写进界面，方便判断当前跑的是哪一版
  $('#app-version').textContent = `v${APP_VERSION}`
  $('#auth-version').textContent = `v${APP_VERSION}`

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
    showApp()
    await refresh()   // 登录状态确认后，才去加载文件列表
  } catch {
    // 走到这里说明没登录（或令牌过期、服务器出错），一律退回登录页
    showAuth()
  }
}

// 最后一行执行启动。
// 因为 <script> 标签放在 </body> 前面，此时页面元素都已存在，可以直接操作。
boot()
