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
     → 数据加载 → 上传 → 灯箱预览 → 事件绑定 → 启动
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * $ 和 $$ 是两个简写工具。
 *   $  = 找一个元素        $('#upload-btn')
 *   $$ = 找一堆元素，返回数组  $$('.card')
 * 等价于原生的 querySelector / querySelectorAll，只是写起来短一些。
 */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

const CATEGORY_LABEL = { all: '全部', image: '照片', video: '视频', file: '文件' }

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
  total: 0,          // 当前筛选条件下共有多少条（由服务器告知）
  hasMore: false,    // 是否还有下一页
  loadingMore: false, // 是否正在加载下一页
  requireRegistrationCode: false, // 服务端是否要求注册码（决定要不要显示那个输入框）
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
  // 分页状态也要重置，否则换账号登录后会接着上一个人的「已加载数量」往下取
  state.total = 0
  state.hasMore = false
  state.loadingMore = false
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

function cardHtml(record) {
  const raw = apiUrl(`/api/files/${record.id}/raw`)
  let thumb
  if (record.category === 'image') {
    thumb = `<img src="${raw}" alt="${escapeHtml(record.name)}" loading="lazy" decoding="async">`
  } else if (record.category === 'video') {
    thumb = `<video src="${raw}#t=0.5" preload="metadata" muted playsinline></video>
      <div class="card-play"><span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg></span></div>`
  } else {
    thumb = fileGlyph(record)
  }

  return `<article class="card" data-id="${record.id}" tabindex="0">
    <div class="card-thumb" data-open>
      <span class="card-badge" data-cat="${record.category}"><i></i>${CATEGORY_LABEL[record.category]}</span>
      <div class="card-actions">
        <a href="${apiUrl(`/api/files/${record.id}/download`)}" title="下载" aria-label="下载" data-no-open>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg>
        </a>
        <button type="button" title="删除" aria-label="删除" data-delete data-no-open>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 11a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-11"/></svg>
        </button>
      </div>
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

  title.textContent = CATEGORY_LABEL[state.category]
  // 显示的是「总数」，不是「已加载数」—— 用户关心的是这里到底有多少东西
  count.textContent = `${state.total} 项`

  if (!state.files.length) {
    grid.innerHTML = ''
    empty.hidden = false
    const searching = Boolean(state.query)
    $('#empty-title').textContent = searching ? '没有匹配的文件' : '这里还是空的'
    $('#empty-desc').textContent = searching
      ? '换个关键词试试，或清空搜索框查看全部内容。'
      : state.category === 'all'
        ? '把视频、照片或文件拖进来，或点击右上角「上传」按钮。'
        : `还没有${CATEGORY_LABEL[state.category]}，上传一些试试。`
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
  $('#storage-value').textContent = formatSize(usage.bytes)
  $$('[data-count]').forEach((node) => {
    const key = node.dataset.count
    node.textContent = key === 'all' ? usage.total : (usage.byCategory[key] || 0)
  })
  const total = usage.bytes || 1
  $$('[data-bar]').forEach((node) => {
    const bytes = usage.bytesByCategory[node.dataset.bar] || 0
    node.style.setProperty('--w', `${(bytes / total) * 100}%`)
  })
  $$('[data-size]').forEach((node) => {
    node.textContent = formatSize(usage.bytesByCategory[node.dataset.size] || 0)
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
    const data = await api(`/api/files?${buildListParams(0)}`)

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
    const data = await api(`/api/files?${buildListParams(state.files.length)}`)

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
function uploadOne(file, forcedCategory) {
  return new Promise((resolve) => {
    // 文件名要经过 URLSearchParams 编码，否则中文名会让服务器返回 400
    const params = new URLSearchParams({ name: file.name })
    if (forcedCategory) params.set('category', forcedCategory)

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
        toast.succeed(`已上传 · ${formatSize(file.size)}`)
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

async function uploadFiles(fileList, forcedCategory) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  const results = await Promise.all(files.map((file) => uploadOne(file, forcedCategory)))
  if (results.some(Boolean)) await refresh({ silent: true })
}

/* ───────────────────────────── 灯箱 ───────────────────────────── */

function openLightbox(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return
  state.lightboxId = id

  const raw = apiUrl(`/api/files/${record.id}/raw`)
  $('#lightbox-name').textContent = record.name
  $('#lightbox-sub').textContent = `${CATEGORY_LABEL[record.category]} · ${formatSize(record.size)} · ${formatDate(record.createdAt)}`
  $('#lightbox-download').href = apiUrl(`/api/files/${record.id}/download`)

  const body = $('#lightbox-body')
  if (record.category === 'image') {
    body.innerHTML = `<img src="${raw}" alt="${escapeHtml(record.name)}">`
  } else if (record.category === 'video') {
    body.innerHTML = `<video src="${raw}" controls autoplay playsinline></video>`
  } else {
    body.innerHTML = `<div class="file-preview">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10A2.5 2.5 0 0 0 19.5 18V9.5z"/><path d="M13.5 3.5v6h6"/></svg>
        <p>该格式暂不支持在线预览，可直接下载查看。</p>
      </div>`
  }

  $('#lightbox').hidden = false
  document.body.style.overflow = 'hidden'
}

function closeLightbox() {
  const box = $('#lightbox')
  if (box.hidden) return
  $('#lightbox-body').innerHTML = ''
  box.hidden = true
  state.lightboxId = null
  document.body.style.overflow = ''
}

async function deleteFile(id) {
  const record = state.files.find((row) => row.id === id)
  if (!record) return
  if (!window.confirm(`确定删除「${record.name}」吗？此操作不可恢复。`)) return
  try {
    await api(`/api/files/${id}`, { method: 'DELETE' })
    if (state.lightboxId === id) closeLightbox()
    notify(`已删除「${record.name}」`, 'ok')
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
    $$('#cat-list .cat-item').forEach((item) => item.classList.toggle('is-active', item === btn))
    refresh()
  })

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
  const overlay = $('#drop-overlay')
  window.addEventListener('dragenter', (event) => {
    if (!state.user || !event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return
    dragDepth += 1
    overlay.hidden = false
  })
  window.addEventListener('dragover', (event) => {
    if (!overlay.hidden) event.preventDefault()
  })
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) overlay.hidden = true
  })
  window.addEventListener('drop', async (event) => {
    if (!state.user) return
    event.preventDefault()
    dragDepth = 0
    overlay.hidden = true
    const files = event.dataTransfer && event.dataTransfer.files
    if (files && files.length) {
      const forced = state.category === 'all' ? null : state.category
      await uploadFiles(files, forced)
    }
  })

  // 卡片交互（事件委托）
  const grid = $('#file-grid')
  grid.addEventListener('click', (event) => {
    const card = event.target.closest('.card')
    if (!card) return
    if (event.target.closest('[data-delete]')) {
      deleteFile(card.dataset.id)
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
  $('#lightbox-delete').addEventListener('click', () => {
    if (state.lightboxId) deleteFile(state.lightboxId)
  })

  // 弹窗关闭
  $('#password-modal').addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) $('#password-modal').hidden = true
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!$('#lightbox').hidden) closeLightbox()
    else if (!$('#password-modal').hidden) $('#password-modal').hidden = true
    else if (!$('#user-dropdown').hidden) $('#user-dropdown').hidden = true
  })

  // 窗口尺寸变化时关闭灯箱里的视频播放，避免后台继续播放
  window.addEventListener('resize', () => {
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
