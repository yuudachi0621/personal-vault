/* ══════════════════════════════════════════════════════════════════════════
   public/transfers.js —— 上传 / 下载传输中心
   ══════════════════════════════════════════════════════════════════════════

   本文件负责三件事：
   1. 把上传改成 8 MiB 分块会话，支持暂停、继续、取消和刷新后恢复；
   2. 在支持 File System Access API 的浏览器中，用 Range 分块写入用户选择的
      本地文件，实现可暂停的下载；不支持的浏览器回退到普通下载；
   3. 维护传输页面的任务列表、进度、速度和操作按钮。

   上传的 File 对象和下载的 FileSystemFileHandle 无法安全写进 localStorage。
   因此上传任务刷新后需要重新选择原文件，下载任务刷新后需要重新授权写入位置。
   ══════════════════════════════════════════════════════════════════════════ */

const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const MAX_PARALLEL_UPLOADS = 2
const UPLOAD_STORE_PREFIX = 'personal-vault:uploads:'
const DOWNLOAD_STORE_PREFIX = 'personal-vault:downloads:'
const TRANSFER_RENDER_DELAY_MS = 120
const TERMINAL_TRANSFER_STATUSES = new Set(['completed', 'cancelled', 'external'])

const transfers = {
  ownerId: null,
  uploads: [],
  downloads: [],
  activeTab: 'upload',
  sequence: 0,
  renderTimer: 0,
}

const uploadRuns = new Map()
const downloadRuns = new Map()
let transferDbPromise = null
let uploadPumpTimer = 0
let uploadQueueBlockedUntil = 0
let uploadQueueBusyDelay = 0
let uploadQueueProbeOnly = false
const UPLOAD_BUSY_RETRY_MS = 3000
const UPLOAD_BUSY_MAX_RETRY_MS = 60000

function host() {
  const value = window.VaultTransferHost
  if (!value) throw new Error('传输模块初始化顺序错误')
  return value
}

function transferStoreKey(prefix) {
  const { state } = host()
  return state.user ? `${prefix}${state.user.id}` : ''
}

function readStoredTransferList(key) {
  if (!key) return []
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function writeStoredTransferList(key, value) {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私浏览或存储配额不足时，仅保留当前页面内的任务 */
  }
}

function newTransferId(kind) {
  transfers.sequence += 1
  const random = Math.random().toString(36).slice(2, 9)
  return `${kind}-${Date.now().toString(36)}-${transfers.sequence}-${random}`
}

function findTransferTask(kind, id) {
  const list = kind === 'upload' ? transfers.uploads : transfers.downloads
  return list.find((task) => task.id === id) || null
}

function transferProgress(task) {
  if (!task.size) return 0
  return Math.min(100, Math.max(0, (task.loaded / task.size) * 100))
}

function transferIsActive(task) {
  return !TERMINAL_TRANSFER_STATUSES.has(task.status)
}

/** 隐私传输任务在隐私空间锁定时完全隐藏，避免文件名和大小泄露。 */
function transferIsVisible(task) {
  return !task.isPrivate || Boolean(host().state.privacyUnlocked)
}

function transferCanRetry(task) {
  return task.retryable !== false && !['processing', 'cancelling'].includes(task.status)
}

function transferStatusText(task) {
  if (task.status === 'waiting') {
    if (task.kind === 'upload' && !task.file) return '等待重新选择原文件'
    return task.waitingReason || '排队中'
  }
  if (task.status === 'running') {
    if (task.kind === 'upload' && task.finalizing) return '正在校验并保存'
    return task.kind === 'upload' ? '正在上传' : '正在下载'
  }
  if (task.status === 'processing') return '正在校验并保存'
  if (task.status === 'cancelling') return '正在取消'
  if (task.status === 'paused') return '已暂停，可继续'
  if (task.status === 'failed') return '传输失败'
  if (task.status === 'completed') return '已完成'
  if (task.status === 'cancelled') return '已取消'
  if (task.status === 'external') return '已交给浏览器下载'
  return '等待中'
}

function transferTaskActions(task) {
  const { escapeHtml } = host()
  const id = escapeHtml(task.id)
  const kind = task.kind
  const button = (action, label, className = '') =>
    `<button type="button" class="${className}" data-transfer-action="${action}" data-transfer-kind="${kind}" data-transfer-id="${id}">${label}</button>`

  if (task.status === 'running') {
    if (task.kind === 'upload' && task.finalizing) return '<button type="button" disabled>正在保存</button>'
    return `${button('pause', '暂停')}${button('cancel', '取消', 'is-danger')}`
  }
  if (task.status === 'waiting') {
    if (task.kind === 'upload' && !task.file) {
      return `${button('resume', '选择文件继续')}${button('remove', '移除', 'is-danger')}`
    }
    return `${button('pause', '暂停')}${button('cancel', '取消', 'is-danger')}`
  }
  if (['paused', 'failed'].includes(task.status)) {
    if (!transferCanRetry(task)) return button('remove', '移除')
    const resumeLabel = task.kind === 'upload' && !task.file ? '选择文件继续' : '继续'
    const cancelAction = task.kind === 'upload' && task.uploadId ? 'cancel' : 'remove'
    return `${button('resume', resumeLabel)}${button(cancelAction, '取消', 'is-danger')}`
  }
  if (['processing', 'cancelling'].includes(task.status)) {
    return '<button type="button" disabled>请稍候</button>'
  }
  return button('remove', '移除记录')
}

function transferIcon(kind) {
  if (kind === 'download') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg>'
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V9m0 0-4 4m4-4 4 4"/><path d="M5 5h14"/></svg>'
}

function transferTaskHtml(task) {
  const { escapeHtml, formatSize } = host()
  const progress = transferProgress(task)
  const percent = `${Math.round(progress)}%`
  const bytes = task.size > 0
    ? `${formatSize(task.loaded)} / ${formatSize(task.size)}`
    : formatSize(task.loaded)
  const speed = task.status === 'running' && task.speed > 0 ? ` · ${formatSize(task.speed)}/s` : ''
  const statusError = ['failed', 'paused'].includes(task.status) && task.error
  const note = task.error ? `<p class="transfer-note${statusError ? ' is-error' : ''}">${escapeHtml(task.error)}</p>` : ''
  const stateClass = ['completed', 'failed', 'paused'].includes(task.status) ? ` is-${task.status}` : ''

  return `<article class="transfer-task${stateClass}" data-kind="${task.kind}" data-task-id="${escapeHtml(task.id)}">
    <div class="transfer-kind-icon">${transferIcon(task.kind)}</div>
    <div class="transfer-main">
      <div class="transfer-title-row">
        <strong class="transfer-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</strong>
        <span class="transfer-percent">${percent}</span>
      </div>
      <div class="transfer-track"><i style="--progress:${progress.toFixed(2)}%"></i></div>
      <div class="transfer-meta">
        <span class="transfer-status${statusError ? ' is-error' : ''}">${escapeHtml(transferStatusText(task))}</span>
        <span class="transfer-bytes">${bytes}${speed}</span>
      </div>
      ${note}
    </div>
    <div class="transfer-buttons">${transferTaskActions(task)}</div>
  </article>`
}

function syncTransferViewVisibility() {
  const { $, state } = host()
  const active = state.transferMode
  $('#transfer-panel').hidden = !active
  $('.toolbar-tools').hidden = active
  if (!active) {
    $('#file-grid').hidden = false
    return
  }

  $('#file-grid').hidden = true
  $('#skeleton').hidden = true
  $('#empty-state').hidden = true
  $('#trash-banner').hidden = true
  $('#load-more-wrap').hidden = true
  $('#view-title').textContent = '传输'
  const activeCount = [...transfers.uploads, ...transfers.downloads]
    .filter((task) => transferIsVisible(task) && transferIsActive(task)).length
  $('#view-count').textContent = `${activeCount} 个未完成`
}

function renderTransferPanel() {
  const { $, $$, state } = host()
  const panel = $('#transfer-panel')
  if (!panel) return

  const visibleUploads = transfers.uploads.filter(transferIsVisible)
  const visibleDownloads = transfers.downloads.filter(transferIsVisible)
  const activeUploads = visibleUploads.filter(transferIsActive).length
  const activeDownloads = visibleDownloads.filter(transferIsActive).length
  $('#transfer-upload-count').textContent = String(visibleUploads.length)
  $('#transfer-download-count').textContent = String(visibleDownloads.length)
  $('#transfer-count').textContent = String(activeUploads + activeDownloads)
  $('#transfer-btn').classList.toggle('has-active', activeUploads + activeDownloads > 0)

  $$('[data-transfer-tab]').forEach((button) => {
    const selected = button.dataset.transferTab === transfers.activeTab
    button.classList.toggle('is-active', selected)
    button.setAttribute('aria-selected', selected ? 'true' : 'false')
  })

  const tasks = transfers.activeTab === 'upload' ? visibleUploads : visibleDownloads
  const sorted = tasks.slice().sort((a, b) => b.createdAt - a.createdAt)
  const list = $('#transfer-list')
  const empty = $('#transfer-empty')
  list.innerHTML = sorted.map(transferTaskHtml).join('')
  list.hidden = sorted.length === 0
  empty.hidden = sorted.length > 0
  if (!sorted.length) {
    $('strong', empty).textContent = transfers.activeTab === 'upload' ? '暂无上传任务' : '暂无下载任务'
    $('span', empty).textContent = transfers.activeTab === 'upload'
      ? '选择或拖入文件后，上传进度会显示在这里。'
      : '从文件卡片或预览窗口下载后，进度会显示在这里。'
  }

  $('#transfer-pause-all').disabled = !sorted.some((task) => ['running', 'waiting'].includes(task.status))
  $('#transfer-resume-all').disabled = !sorted.some((task) => ['paused', 'failed'].includes(task.status) && transferCanRetry(task))
  $('#transfer-clear-done').disabled = !sorted.some((task) => TERMINAL_TRANSFER_STATUSES.has(task.status))

  syncTransferViewVisibility()

  if (state.transferMode) {
    const activeCount = [...transfers.uploads, ...transfers.downloads]
      .filter((task) => transferIsVisible(task) && transferIsActive(task)).length
    $('#view-count').textContent = `${activeCount} 个未完成`
  }
}

function scheduleTransferRender() {
  if (transfers.renderTimer) return
  transfers.renderTimer = window.setTimeout(() => {
    transfers.renderTimer = 0
    renderTransferPanel()
  }, TRANSFER_RENDER_DELAY_MS)
}

function openTransferView() {
  const { $, $$, state } = host()
  state.transferMode = true
  $$('#cat-list .cat-item').forEach((item) => item.classList.toggle('is-active', item.id === 'transfer-btn'))
  $('#privacy-btn').classList.remove('is-active')
  $('#trash-btn').classList.remove('is-active')
  renderTransferPanel()
}

function leaveTransferView() {
  const { $, $$, state, renderGrid, renderLoadMore } = host()
  state.transferMode = false
  $('#transfer-btn').classList.remove('is-active')
  if (state.privacyMode) {
    $('#privacy-btn').classList.add('is-active')
  } else {
    $$('#cat-list .cat-item[data-cat]').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.cat === state.category)
    })
  }
  renderGrid()
  renderLoadMore()
  renderTransferPanel()
}

function setTransferTab(tab) {
  if (!['upload', 'download'].includes(tab)) return
  transfers.activeTab = tab
  renderTransferPanel()
}

function updateTransferProgress(task, loaded) {
  const next = Math.max(0, Math.min(task.size || Number.MAX_SAFE_INTEGER, Number(loaded) || 0))
  const now = performance.now()
  if (task.status === 'running') {
    if (task.lastSampleAt && now - task.lastSampleAt >= 450 && next >= task.lastSampleLoaded) {
      const elapsed = (now - task.lastSampleAt) / 1000
      if (elapsed > 0) task.speed = (next - task.lastSampleLoaded) / elapsed
      task.lastSampleAt = now
      task.lastSampleLoaded = next
    } else if (!task.lastSampleAt) {
      task.lastSampleAt = now
      task.lastSampleLoaded = next
    }
  }
  task.loaded = next
  scheduleTransferRender()
}

function resetTransferSpeed(task) {
  task.speed = 0
  task.lastSampleAt = 0
  task.lastSampleLoaded = task.loaded
}
function persistUploadTasks() {
  const records = transfers.uploads
    .filter((task) => task.uploadId && !TERMINAL_TRANSFER_STATUSES.has(task.status))
    .map((task) => ({
      id: task.id,
      uploadId: task.uploadId,
      ownerId: task.ownerId,
      name: task.name,
      size: task.size,
      mime: task.mime,
      lastModified: task.lastModified,
      signature: task.signature,
      offset: task.offset,
      isPrivate: task.isPrivate,
      updatedAt: new Date().toISOString(),
    }))
  writeStoredTransferList(transferStoreKey(UPLOAD_STORE_PREFIX), records)
}

function persistDownloadTasks() {
  const records = transfers.downloads
    .filter((task) => task.recordId && task.offset < task.size && !TERMINAL_TRANSFER_STATUSES.has(task.status))
    .map((task) => ({
      id: task.id,
      ownerId: task.ownerId,
      recordId: task.recordId,
      name: task.name,
      size: task.size,
      offset: task.offset,
      etag: task.etag || '',
      isPrivate: Boolean(task.isPrivate),
      updatedAt: new Date().toISOString(),
    }))
  writeStoredTransferList(transferStoreKey(DOWNLOAD_STORE_PREFIX), records)
}

function openTransferDb() {
  if (transferDbPromise) return transferDbPromise
  transferDbPromise = new Promise((resolve) => {
    if (!('indexedDB' in window)) {
      resolve(null)
      return
    }
    const request = indexedDB.open('personal-vault-transfers', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('download-handles')) {
        request.result.createObjectStore('download-handles')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return transferDbPromise
}

async function storeDownloadHandle(id, handle) {
  const db = await openTransferDb()
  if (!db) return
  await new Promise((resolve) => {
    try {
      const tx = db.transaction('download-handles', 'readwrite')
      tx.objectStore('download-handles').put(handle, id)
      tx.oncomplete = resolve
      tx.onerror = resolve
      tx.onabort = resolve
    } catch {
      // 某些浏览器不允许持久化 FileSystemHandle；内存中的句柄仍可继续使用。
      resolve()
    }
  })
}

async function loadDownloadHandle(id) {
  const db = await openTransferDb()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction('download-handles', 'readonly')
    const request = tx.objectStore('download-handles').get(id)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => resolve(null)
  })
}

async function removeDownloadHandle(id) {
  const db = await openTransferDb()
  if (!db) return
  await new Promise((resolve) => {
    try {
      const tx = db.transaction('download-handles', 'readwrite')
      tx.objectStore('download-handles').delete(id)
      tx.oncomplete = resolve
      tx.onerror = resolve
      tx.onabort = resolve
    } catch {
      resolve()
    }
  })
}

async function restoreTransferTasks() {
  const { state } = host()
  if (!state.user) return
  const ownerId = state.user.id
  if (transfers.ownerId && transfers.ownerId !== ownerId) {
    transfers.uploads = []
    transfers.downloads = []
    transfers.activeTab = 'upload'
  }
  transfers.ownerId = ownerId

  const savedUploads = readStoredTransferList(transferStoreKey(UPLOAD_STORE_PREFIX))
  for (const saved of savedUploads) {
    if (!saved || saved.ownerId !== ownerId || !saved.uploadId || (saved.id && findTransferTask('upload', saved.id))) continue
    transfers.uploads.push({
      id: saved.id || newTransferId('upload'),
      kind: 'upload',
      ownerId,
      name: String(saved.name || '未命名文件'),
      size: Number(saved.size) || 0,
      mime: String(saved.mime || 'application/octet-stream'),
      lastModified: Number(saved.lastModified) || 0,
      signature: String(saved.signature || ''),
      uploadId: saved.uploadId,
      offset: Number(saved.offset) || 0,
      loaded: Number(saved.offset) || 0,
      isPrivate: Boolean(saved.isPrivate),
      status: 'paused',
      error: '页面已刷新，请重新选择原文件后继续。',
      retryable: true,
      file: null,
      xhr: null,
      speed: 0,
      lastSampleAt: 0,
      lastSampleLoaded: 0,
      createdAt: Date.parse(saved.updatedAt) || Date.now(),
    })
  }

  const savedDownloads = readStoredTransferList(transferStoreKey(DOWNLOAD_STORE_PREFIX))
  for (const saved of savedDownloads) {
    if (!saved || saved.ownerId !== ownerId || !saved.id || findTransferTask('download', saved.id)) continue
    const size = Number(saved.size) || 0
    const offset = Math.min(Math.max(0, Number(saved.offset) || 0), size)
    transfers.downloads.push({
      id: saved.id,
      kind: 'download',
      ownerId,
      recordId: saved.recordId,
      name: String(saved.name || '未命名文件'),
      size,
      offset,
      loaded: offset,
      etag: String(saved.etag || ''),
      isPrivate: Boolean(saved.isPrivate),
      status: 'paused',
      error: '',
      retryable: true,
      handle: null,
      writable: null,
      controller: null,
      speed: 0,
      lastSampleAt: 0,
      lastSampleLoaded: offset,
      pendingPermission: true,
      resetDestination: false,
      createdAt: Date.parse(saved.updatedAt) || Date.now(),
    })
  }

  await Promise.all(transfers.downloads.map(async (task) => {
    if (task.handle || TERMINAL_TRANSFER_STATUSES.has(task.status)) return
    task.handle = await loadDownloadHandle(task.id)
    if (!task.handle) task.error = '页面已刷新，请重新选择保存位置后继续。'
  }))
  renderTransferPanel()
}

function pauseTransfersForAuth() {
  for (const task of transfers.uploads) {
    if (task.status === 'running') {
      task.status = 'paused'
      task.loaded = task.offset
      resetTransferSpeed(task)
      if (task.xhr) task.xhr.abort()
    }
  }
  for (const task of transfers.downloads) {
    if (task.status === 'running') {
      task.status = 'paused'
      task.loaded = task.offset
      resetTransferSpeed(task)
      if (task.controller) task.controller.abort()
    }
  }
  persistUploadTasks()
  persistDownloadTasks()
  scheduleTransferRender()
}

/* ── 可续传上传 ───────────────────────────────────────────────────── */

function createUploadTask(file) {
  const { state, fileSignature } = host()
  return {
    id: newTransferId('upload'),
    kind: 'upload',
    ownerId: state.user.id,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    lastModified: file.lastModified || 0,
    signature: fileSignature(file),
    file,
    uploadId: null,
    offset: 0,
    loaded: 0,
    isPrivate: state.privacyMode,
    status: 'waiting',
    error: '',
    retryable: true,
    xhr: null,
    waitingReason: '',
    finalizing: false,
    speed: 0,
    lastSampleAt: 0,
    lastSampleLoaded: 0,
    createdAt: Date.now(),
  }
}

async function enqueueUploadFiles(fileList) {
  const { state, uniqueFiles, fileSignature, notify } = host()
  if (!state.user) return
  const files = uniqueFiles(fileList)
  if (!files.length) return

  let added = 0
  let reused = 0
  for (const file of files) {
    const signature = fileSignature(file)
    const existing = transfers.uploads.find((task) => task.signature === signature && transferIsActive(task))
    if (existing) {
      reused += 1
      if (!existing.file) {
        existing.file = file
        existing.error = ''
        if (['paused', 'failed'].includes(existing.status)) {
          existing.status = 'waiting'
          existing.retryable = true
          resetTransferSpeed(existing)
        }
      }
      continue
    }
    const completed = transfers.uploads.find((task) => task.signature === signature && task.status === 'completed')
    if (completed) {
      notify('这个文件刚刚已经上传完成，无需重复上传')
      continue
    }
    transfers.uploads.push(createUploadTask(file))
    added += 1
  }

  if (reused && !added) notify('相同文件已在上传队列中，已复用原任务', 'ok')
  if (added || reused) {
    renderTransferPanel()
    scheduleUploadQueuePump()
  }
}

async function ensureTransferPrivacy(task) {
  const { state, requestPrivacyUnlock, updatePrivacyIndicator, notePrivacyActivity } = host()
  if (!task.isPrivate || state.privacyUnlocked) return
  const unlocked = await requestPrivacyUnlock()
  if (!unlocked) {
    const error = new Error('隐私空间已锁定，继续时需要重新输入隐私密码')
    error.code = 'PRIVACY_CANCELLED'
    throw error
  }
  state.privacyUnlocked = true
  updatePrivacyIndicator()
  notePrivacyActivity()
}

function readChunkResponse(xhr) {
  try {
    return xhr.responseText ? JSON.parse(xhr.responseText) : null
  } catch {
    return null
  }
}

function uploadChunkRequest(task, blob, offset) {
  const { apiUrl, notePrivacyActivity } = host()
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    task.xhr = xhr
    xhr.open('PATCH', apiUrl(`/api/uploads/${encodeURIComponent(task.uploadId)}`))
    xhr.withCredentials = true
    xhr.timeout = 120_000
    xhr.setRequestHeader('Upload-Offset', String(offset))
    xhr.setRequestHeader('Upload-Length', String(task.size))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')

    if (!blob.size && !task.finalizing) {
      task.finalizing = true
      renderTransferPanel()
    }

    xhr.upload.addEventListener('progress', (event) => {
      notePrivacyActivity()
      if (!event.lengthComputable) return
      updateTransferProgress(task, offset + event.loaded)
      if (offset + event.loaded >= task.size && !task.finalizing) {
        task.finalizing = true
        renderTransferPanel()
      }
    })

    const finish = () => {
      if (task.xhr === xhr) task.xhr = null
    }

    xhr.addEventListener('load', () => {
      finish()
      const body = readChunkResponse(xhr)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({
          offset: Number(xhr.getResponseHeader('Upload-Offset')) || Number(body && body.upload && body.upload.offset) || task.size,
          file: body && body.file ? body.file : null,
        })
        return
      }
      const error = new Error((body && body.error) || `上传失败（${xhr.status || '网络异常'}）`)
      error.status = xhr.status
      error.code = body && body.code
      error.offset = Number(xhr.getResponseHeader('Upload-Offset'))
      reject(error)
    })

    xhr.addEventListener('error', () => {
      finish()
      const error = new Error('网络异常，上传已暂停；恢复网络后可继续')
      error.code = 'NETWORK_ERROR'
      reject(error)
    })
    xhr.addEventListener('timeout', () => {
      finish()
      const error = new Error('上传分块超时，可继续重试')
      error.code = 'NETWORK_ERROR'
      reject(error)
    })
    xhr.addEventListener('abort', () => {
      finish()
      const error = new Error('上传已暂停')
      error.name = 'AbortError'
      error.code = 'ABORTED'
      reject(error)
    })

    xhr.send(blob)
  })
}

async function getUploadSession(task) {
  const { api } = host()
  const data = await api(`/api/uploads/${encodeURIComponent(task.uploadId)}`)
  return data.upload
}

async function createUploadSession(task) {
  const { api } = host()
  await ensureTransferPrivacy(task)
  const data = await api('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: task.name,
      mime: task.mime,
      size: task.size,
      private: task.isPrivate,
    }),
  })
  task.uploadId = data.upload.id
  task.offset = Number(data.upload.offset) || 0
  task.loaded = task.offset
  task.chunkSize = Number(data.upload.chunkSize) || UPLOAD_CHUNK_BYTES
  uploadQueueBusyDelay = 0
  uploadQueueProbeOnly = false
  persistUploadTasks()
  scheduleUploadQueuePump()
  return data.upload
}

async function ensureUploadSession(task) {
  await ensureTransferPrivacy(task)
  if (task.uploadId) {
    try {
      const session = await getUploadSession(task)
      if (session.name !== task.name || Number(session.size) !== Number(task.size)) {
        task.uploadId = null
      } else {
        task.offset = Number(session.offset) || 0
        task.loaded = task.offset
        persistUploadTasks()
        return
      }
    } catch (error) {
      if (error.status !== 404) throw error
      task.uploadId = null
      task.offset = 0
      task.loaded = 0
    }
  }
  await createUploadSession(task)
}

function markUploadFinished(task) {
  task.status = 'completed'
  task.loaded = task.size
  task.speed = 0
  task.error = ''
  task.xhr = null
  persistUploadTasks()
}

async function handleUploadFailure(task, error) {
  const { showAuth, state, updatePrivacyIndicator } = host()
  task.finalizing = false
  if (['paused', 'cancelled'].includes(task.status)) {
    task.loaded = task.offset
    resetTransferSpeed(task)
    return
  }
  const status = Number(error && error.status)
  const code = error && error.code
  if (status === 401) {
    task.status = 'paused'
    task.error = '登录状态已失效，请重新登录后继续'
    resetTransferSpeed(task)
    showAuth()
    return
  }
  if (code === 'PRIVACY_LOCKED' || code === 'PRIVACY_CANCELLED') {
    if (code === 'PRIVACY_LOCKED') {
      state.privacyUnlocked = false
      updatePrivacyIndicator()
    }
    task.status = 'paused'
    task.error = error.message
    task.retryable = true
    resetTransferSpeed(task)
    persistUploadTasks()
    return
  }
  if (code === 'UPLOAD_BUSY') {
    task.status = 'waiting'
    task.waitingReason = '等待其他上传完成'
    task.error = ''
    task.retryable = true
    task.loaded = task.offset
    resetTransferSpeed(task)
    uploadQueueProbeOnly = true
    uploadQueueBusyDelay = uploadQueueBusyDelay
      ? Math.min(uploadQueueBusyDelay * 2, UPLOAD_BUSY_MAX_RETRY_MS)
      : UPLOAD_BUSY_RETRY_MS
    uploadQueueBlockedUntil = Date.now() + uploadQueueBusyDelay
    persistUploadTasks()
    scheduleUploadQueuePump()
    return
  }
  if (code === 'DUPLICATE_FILE') {
    task.status = 'failed'
    task.error = error.message
    task.retryable = false
    task.uploadId = null
    resetTransferSpeed(task)
    persistUploadTasks()
    return
  }
  if (['FILE_TOO_LARGE', 'INVALID_FILE_SIZE', 'QUOTA_EXCEEDED', 'INSUFFICIENT_STORAGE'].includes(code)) {
    task.status = 'failed'
    task.error = error.message
    task.retryable = code === 'QUOTA_EXCEEDED' || code === 'INSUFFICIENT_STORAGE'
    resetTransferSpeed(task)
    persistUploadTasks()
    return
  }

  const transient = !status || status >= 500 || status === 408 || status === 429
  task.status = transient ? 'paused' : 'failed'
  task.error = error && error.finalizeStage
    ? '服务器保存文件时暂时失败，点击继续重试'
    : (error && error.message ? error.message : '上传失败，请稍后重试')
  task.retryable = transient || status < 500
  task.loaded = task.offset
  resetTransferSpeed(task)
  persistUploadTasks()
}

async function syncUploadOffset(task) {
  const session = await getUploadSession(task)
  task.offset = Number(session.offset) || 0
  task.loaded = task.offset
  task.finalizing = false
  persistUploadTasks()
  return session
}

async function runUploadTask(task) {
  const { state, refresh, notePrivacyActivity, notify } = host()
  if (!task.file || !state.user) return
  task.status = 'running'
  task.error = ''
  task.waitingReason = ''
  task.finalizing = false
  resetTransferSpeed(task)
  scheduleTransferRender()

  try {
    await ensureUploadSession(task)
    let inProgressRetries = 0
    let transientRetries = 0
    let finalizeOnlyAttempts = 0

    while (task.status === 'running') {
      const finalizeOnly = task.offset >= task.size
      if (finalizeOnly && ++finalizeOnlyAttempts > 3) {
        const error = new Error('服务器多次未能完成文件保存，请取消后重新上传')
        error.status = 500
        error.finalizeStage = true
        throw error
      }
      if (finalizeOnly) {
        task.finalizing = true
        scheduleTransferRender()
      }

      const blob = finalizeOnly
        ? new Blob([])
        : task.file.slice(task.offset, Math.min(task.size, task.offset + (task.chunkSize || UPLOAD_CHUNK_BYTES)))
      let result
      try {
        result = await uploadChunkRequest(task, blob, task.offset)
        inProgressRetries = 0
        transientRetries = 0
      } catch (error) {
        const wasFinalizing = task.finalizing || finalizeOnly
        task.finalizing = false
        if (task.status !== 'running') break

        if (error.code === 'UPLOAD_OFFSET_MISMATCH') {
          if (Number.isInteger(error.offset) && error.offset >= 0) {
            task.offset = error.offset
            task.loaded = task.offset
            persistUploadTasks()
          } else {
            await syncUploadOffset(task)
          }
          continue
        }
        if (error.code === 'UPLOAD_IN_PROGRESS' && inProgressRetries < 3) {
          inProgressRetries += 1
          await new Promise((resolve) => setTimeout(resolve, 600 * inProgressRetries))
          continue
        }

        const status = Number(error && error.status)
        const transient = !status || status >= 500 || status === 408 || status === 429
        if (error.code !== 'UPLOAD_BUSY' && transient && transientRetries < 2) {
          transientRetries += 1
          await new Promise((resolve) => setTimeout(resolve, 650 * transientRetries))
          try { await syncUploadOffset(task) } catch { /* 下一轮请求会返回明确错误 */ }
          continue
        }
        error.finalizeStage = wasFinalizing
        throw error
      }

      task.finalizing = false
      if (result.file) {
        markUploadFinished(task)
        notify(`已上传：${task.name}`, 'ok')
        await refresh({ silent: true })
        return
      }

      task.offset = Math.min(task.size, Math.max(task.offset, Number(result.offset) || task.offset + blob.size))
      task.loaded = task.offset
      persistUploadTasks()
      notePrivacyActivity()
      scheduleTransferRender()
    }
  } catch (error) {
    await handleUploadFailure(task, error)
  } finally {
    task.finalizing = false
    resetTransferSpeed(task)
    scheduleTransferRender()
  }
}
function scheduleUploadQueuePump(delay = 0) {
  const { state } = host()
  if (!state.user || uploadPumpTimer) return
  const wait = Math.max(delay, uploadQueueBlockedUntil - Date.now(), 0)
  uploadPumpTimer = window.setTimeout(() => {
    uploadPumpTimer = 0
    pumpUploadQueue()
  }, wait)
}

function pumpUploadQueue() {
  const { state } = host()
  if (!state.user) return
  const blockedFor = uploadQueueBlockedUntil - Date.now()
  if (blockedFor > 0) {
    scheduleUploadQueuePump(blockedFor)
    return
  }
  const concurrency = uploadQueueProbeOnly ? 1 : MAX_PARALLEL_UPLOADS
  while (uploadRuns.size < concurrency) {
    const task = transfers.uploads.find((item) => (
      item.status === 'waiting' && item.file && !uploadRuns.has(item.id)
    ))
    if (!task) break
    const run = runUploadTask(task)
      .catch((error) => handleUploadFailure(task, error))
      .finally(() => {
        uploadRuns.delete(task.id)
        scheduleTransferRender()
        scheduleUploadQueuePump()
      })
    uploadRuns.set(task.id, run)
  }
}

function pauseUploadTask(task) {
  if (task.status === 'waiting') {
    task.status = 'paused'
    task.error = ''
    task.retryable = true
    persistUploadTasks()
    renderTransferPanel()
    return
  }
  if (task.status !== 'running') return
  task.status = 'paused'
  task.error = ''
  task.retryable = true
  task.loaded = task.offset
  resetTransferSpeed(task)
  if (task.xhr) task.xhr.abort()
  persistUploadTasks()
  renderTransferPanel()
}

function pickFileForUploadTask(task) {
  const { fileSignature, notify } = host()
  const input = document.createElement('input')
  input.type = 'file'
  input.hidden = true
  input.addEventListener('change', () => {
    const file = input.files && input.files[0]
    input.remove()
    if (!file) return
    if (fileSignature(file) !== task.signature) {
      notify('选择的文件与原任务不一致，请选择文件名、大小和修改时间都相同的原文件')
      return
    }
    task.file = file
    task.error = ''
    task.retryable = true
    task.status = 'waiting'
    task.waitingReason = ''
    resetTransferSpeed(task)
    renderTransferPanel()
    scheduleUploadQueuePump()
  }, { once: true })
  document.body.appendChild(input)
  input.click()
}

async function resumeUploadTask(task) {
  if (!transferCanRetry(task)) return
  if (!task.file) {
    pickFileForUploadTask(task)
    return
  }
  task.status = 'waiting'
  task.error = ''
  task.waitingReason = ''
  resetTransferSpeed(task)
  renderTransferPanel()
  scheduleUploadQueuePump()
}

async function cancelUploadTask(task) {
  const { api, state } = host()
  if (['completed', 'cancelled'].includes(task.status)) return
  task.status = 'cancelling'
  task.loaded = task.offset
  if (task.xhr) task.xhr.abort()
  renderTransferPanel()

  const running = uploadRuns.get(task.id)
  if (running) {
    try { await running } catch { /* runUploadTask 内部已处理 */ }
  }
  if (task.status === 'completed') {
    renderTransferPanel()
    return
  }
  if (task.uploadId && state.user) {
    try {
      await ensureTransferPrivacy(task)
      await api(`/api/uploads/${encodeURIComponent(task.uploadId)}`, { method: 'DELETE' })
    } catch (error) {
      if (error.status !== 404 && error.code !== 'PRIVACY_CANCELLED') {
        task.error = `取消上传会话失败：${error.message}`
      }
    }
  }
  task.status = 'cancelled'
  task.uploadId = null
  task.file = null
  task.speed = 0
  task.waitingReason = ''
  persistUploadTasks()
  renderTransferPanel()
  scheduleUploadQueuePump()
}
/* ── 可续传下载（File System Access API） ─────────────────────────── */

function supportsResumableDownload() {
  return typeof window.showSaveFilePicker === 'function'
}

function browserDownload(record) {
  const { state, apiUrl } = host()
  const task = {
    id: newTransferId('download'),
    kind: 'download',
    ownerId: state.user && state.user.id,
    recordId: record.id,
    name: record.name,
    size: record.size,
    offset: 0,
    loaded: 0,
    status: 'external',
    error: '当前浏览器不支持在页面内断点续传，已使用浏览器自己的下载功能。',
    retryable: false,
    handle: null,
    writable: null,
    controller: null,
    speed: 0,
    createdAt: Date.now(),
  }
  transfers.downloads.push(task)
  renderTransferPanel()
  const anchor = document.createElement('a')
  anchor.href = apiUrl(`/api/files/${record.id}/download`)
  anchor.download = record.name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function startRecordDownload(record) {
  const { state, notify } = host()
  if (!record || !state.user) return
  if (!supportsResumableDownload()) {
    browserDownload(record)
    return
  }

  let handle
  try {
    handle = await window.showSaveFilePicker({ suggestedName: record.name })
  } catch (error) {
    if (error && error.name === 'AbortError') return
    notify(`无法打开保存位置：${error.message}`)
    return
  }

  const task = {
    id: newTransferId('download'),
    kind: 'download',
    ownerId: state.user.id,
    recordId: record.id,
    name: record.name,
    size: record.size,
    offset: 0,
    loaded: 0,
    etag: '',
    isPrivate: Boolean(record.isPrivate),
    status: 'waiting',
    error: '',
    retryable: true,
    handle,
    writable: null,
    controller: null,
    speed: 0,
    lastSampleAt: 0,
    lastSampleLoaded: 0,
    pendingPermission: false,
    resetDestination: true,
    createdAt: Date.now(),
  }
  transfers.downloads.push(task)
  await storeDownloadHandle(task.id, handle)
  persistDownloadTasks()
  renderTransferPanel()
  startDownloadRun(task)
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim())
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  }
}

async function downloadResponseError(response) {
  let body = null
  try { body = await response.json() } catch { /* 可能是代理返回的 HTML */ }
  const error = new Error((body && body.error) || `下载失败（${response.status}）`)
  error.status = response.status
  error.code = body && body.code
  return error
}

async function ensureDownloadPermission(task) {
  if (!task.handle) {
    const error = new Error('请重新选择保存位置后继续下载')
    error.code = 'DOWNLOAD_HANDLE_MISSING'
    throw error
  }
  if (typeof task.handle.queryPermission !== 'function') return
  const current = await task.handle.queryPermission({ mode: 'readwrite' })
  if (current === 'granted') return
  const requested = await task.handle.requestPermission({ mode: 'readwrite' })
  if (requested !== 'granted') {
    const error = new Error('没有获得写入所选文件的权限')
    error.code = 'DOWNLOAD_PERMISSION_DENIED'
    throw error
  }
}

async function ensureDownloadWritable(task, { reset = false } = {}) {
  if (!task.handle) {
    const error = new Error('请重新选择保存位置后继续下载')
    error.code = 'DOWNLOAD_HANDLE_MISSING'
    throw error
  }
  if (!task.writable) task.writable = await task.handle.createWritable({ keepExistingData: true })
  if (reset || task.resetDestination) {
    await task.writable.truncate(0)
    task.offset = 0
    task.loaded = 0
    task.resetDestination = false
  }
}

async function closeDownloadWritable(task) {
  if (!task.writable) return
  const writable = task.writable
  task.writable = null
  try { await writable.close() } catch { /* 已关闭或流已失效 */ }
}

async function inspectDownload(task) {
  const { apiUrl } = host()
  await ensureTransferPrivacy(task)
  const response = await fetch(apiUrl(`/api/files/${task.recordId}/download`), {
    method: 'HEAD',
    credentials: 'include',
    cache: 'no-store',
  })
  if (!response.ok) throw await downloadResponseError(response)
  const size = Number(response.headers.get('Content-Length'))
  const etag = response.headers.get('ETag') || ''
  if (Number.isFinite(size) && size > 0) task.size = size
  if (task.etag && etag && task.etag !== etag) {
    task.etag = etag
    task.resetDestination = true
    await ensureDownloadWritable(task, { reset: true })
  }
  if (!task.etag) task.etag = etag
  return { size: task.size, etag }
}

async function readDownloadChunk(task, response, baseOffset) {
  const chunks = []
  let received = 0
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    updateTransferProgress(task, baseOffset + bytes.length)
    return bytes
  }
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !value.length) continue
      chunks.push(value)
      received += value.length
      updateTransferProgress(task, baseOffset + received)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

async function writeResumedChunk(task, bytes, startOffset) {
  if (task.status !== 'running') return false
  await task.writable.seek(startOffset)
  await task.writable.write(bytes)
  task.offset = startOffset + bytes.length
  task.loaded = task.offset
  resetTransferSpeed(task)
  persistDownloadTasks()
  scheduleTransferRender()
  return true
}

async function writeFullDownload(task, response) {
  await task.writable.truncate(0)
  task.offset = 0
  task.loaded = 0
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    await task.writable.write(bytes)
    task.offset = bytes.length
    task.loaded = bytes.length
    persistDownloadTasks()
    return
  }

  const reader = response.body.getReader()
  let lastSaved = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !value.length) continue
      if (task.status !== 'running') return
      await task.writable.write(value)
      task.offset += value.length
      updateTransferProgress(task, task.offset)
      if (task.offset - lastSaved >= 4 * 1024 * 1024) {
        lastSaved = task.offset
        persistDownloadTasks()
      }
    }
  } finally {
    reader.releaseLock()
  }
  persistDownloadTasks()
}

async function completeDownloadTask(task) {
  const { notify } = host()
  if (task.writable) {
    await task.writable.truncate(task.size)
    await task.writable.close()
    task.writable = null
  }
  task.status = 'completed'
  task.loaded = task.size
  task.offset = task.size
  task.error = ''
  task.speed = 0
  task.controller = null
  persistDownloadTasks()
  await removeDownloadHandle(task.id)
  notify(`已下载：${task.name}`, 'ok')
  renderTransferPanel()
}

async function handleDownloadFailure(task, error) {
  const { showAuth, state, updatePrivacyIndicator } = host()
  await closeDownloadWritable(task)
  if (task.status === 'cancelled') return
  if (task.status === 'paused') {
    task.loaded = task.offset
    resetTransferSpeed(task)
    return
  }
  const status = Number(error && error.status)
  const code = error && error.code
  if (status === 401) {
    task.status = 'paused'
    task.error = '登录状态已失效，请重新登录后继续'
    showAuth()
    return
  }
  if (code === 'PRIVACY_LOCKED' || code === 'PRIVACY_CANCELLED' || status === 403) {
    state.privacyUnlocked = false
    updatePrivacyIndicator()
    task.status = 'paused'
    task.error = '隐私空间已锁定，继续时需要重新输入隐私密码'
    task.retryable = true
    resetTransferSpeed(task)
    persistDownloadTasks()
    return
  }
  const transient = !status || status >= 500 || status === 408 || status === 429
  const permissionIssue = code === 'DOWNLOAD_PERMISSION_DENIED' || code === 'DOWNLOAD_HANDLE_MISSING'
  task.status = transient || permissionIssue ? 'paused' : 'failed'
  task.error = error && error.message ? error.message : '下载失败，请稍后重试'
  task.retryable = transient || permissionIssue || status < 500
  task.loaded = task.offset
  resetTransferSpeed(task)
  persistDownloadTasks()
}

async function performDownloadTask(task) {
  const { apiUrl } = host()
  await ensureDownloadPermission(task)
  await inspectDownload(task)
  await ensureDownloadWritable(task)
  task.controller = new AbortController()

  while (task.status === 'running' && task.offset < task.size) {
    const start = task.offset
    const end = Math.min(task.size - 1, start + DOWNLOAD_CHUNK_BYTES - 1)
    const headers = { Range: `bytes=${start}-${end}` }
    if (task.etag) headers['If-Range'] = task.etag
    const response = await fetch(apiUrl(`/api/files/${task.recordId}/download`), {
      headers,
      credentials: 'include',
      cache: 'no-store',
      signal: task.controller.signal,
    })

    if (response.status === 200) {
      task.etag = response.headers.get('ETag') || task.etag
      await writeFullDownload(task, response)
      continue
    }
    if (response.status === 416 && task.offset >= task.size) break
    if (!response.ok) throw await downloadResponseError(response)

    const range = parseContentRange(response.headers.get('Content-Range'))
    if (response.status !== 206 || !range) {
      const error = new Error('服务器没有返回可续传的分段响应')
      error.status = response.status
      throw error
    }
    if (range.start !== task.offset) {
      task.offset = range.start
      task.loaded = range.start
      persistDownloadTasks()
      continue
    }

    const bytes = await readDownloadChunk(task, response, range.start)
    if (!bytes.length) {
      const error = new Error('下载分块为空，可继续重试')
      error.code = 'NETWORK_ERROR'
      throw error
    }
    if (task.status !== 'running') return
    await writeResumedChunk(task, bytes, range.start)
  }

  if (task.status === 'running') {
    if (task.offset < task.size) {
      await closeDownloadWritable(task)
      task.status = 'paused'
      task.error = '下载连接提前结束，可继续续传'
      persistDownloadTasks()
      return
    }
    task.status = 'processing'
    scheduleTransferRender()
    await completeDownloadTask(task)
  }
}

function startDownloadRun(task) {
  if (!task || task.status === 'running' || downloadRuns.has(task.id)) return
  task.status = 'running'
  task.error = ''
  resetTransferSpeed(task)
  scheduleTransferRender()
  const run = performDownloadTask(task)
    .catch((error) => handleDownloadFailure(task, error))
    .finally(() => {
      downloadRuns.delete(task.id)
      task.controller = null
      scheduleTransferRender()
    })
  downloadRuns.set(task.id, run)
}

async function resumeDownloadTask(task) {
  const { notify } = host()
  if (!transferCanRetry(task)) return
  try {
    if (!task.handle) {
      if (!supportsResumableDownload()) {
        notify('当前浏览器不支持断点续传下载')
        return
      }
      const handle = await window.showSaveFilePicker({ suggestedName: task.name })
      task.handle = handle
      task.offset = 0
      task.loaded = 0
      task.etag = ''
      task.resetDestination = true
      await storeDownloadHandle(task.id, handle)
    } else {
      await ensureDownloadPermission(task)
      task.pendingPermission = false
    }
  } catch (error) {
    if (error && error.name === 'AbortError') return
    task.status = 'paused'
    task.error = error.message || '没有获得文件写入权限'
    resetTransferSpeed(task)
    persistDownloadTasks()
    renderTransferPanel()
    return
  }
  startDownloadRun(task)
}

function pauseDownloadTask(task) {
  if (task.status === 'waiting') {
    task.status = 'paused'
    task.error = ''
    persistDownloadTasks()
    renderTransferPanel()
    return
  }
  if (task.status !== 'running') return
  task.status = 'paused'
  task.error = ''
  task.retryable = true
  task.loaded = task.offset
  resetTransferSpeed(task)
  if (task.controller) task.controller.abort()
  persistDownloadTasks()
  renderTransferPanel()
}

async function cancelDownloadTask(task) {
  if (TERMINAL_TRANSFER_STATUSES.has(task.status)) return
  task.status = 'cancelled'
  if (task.controller) task.controller.abort()
  await closeDownloadWritable(task)
  await removeDownloadHandle(task.id)
  task.loaded = task.offset
  task.error = task.offset > 0 ? '任务已取消；已经写入目标文件的部分内容可能仍会保留。' : ''
  resetTransferSpeed(task)
  persistDownloadTasks()
  renderTransferPanel()
}
/* ── 传输页交互 ───────────────────────────────────────────────────── */

async function handleTransferAction(kind, id, action) {
  const task = findTransferTask(kind, id)
  if (!task) return
  if (action === 'pause') {
    if (kind === 'upload') pauseUploadTask(task)
    else pauseDownloadTask(task)
    return
  }
  if (action === 'resume') {
    if (kind === 'upload') await resumeUploadTask(task)
    else await resumeDownloadTask(task)
    return
  }
  if (action === 'cancel') {
    if (kind === 'upload') await cancelUploadTask(task)
    else await cancelDownloadTask(task)
    return
  }
  if (action === 'remove') {
    if (!TERMINAL_TRANSFER_STATUSES.has(task.status) && task.status !== 'failed') return
    const list = kind === 'upload' ? transfers.uploads : transfers.downloads
    const index = list.findIndex((item) => item.id === id)
    if (index >= 0) list.splice(index, 1)
    if (kind === 'upload') {
      persistUploadTasks()
    } else {
      persistDownloadTasks()
      await removeDownloadHandle(id)
    }
    renderTransferPanel()
  }
}

function pausePrivateTransfers() {
  for (const task of transfers.uploads) {
    if (task.isPrivate && ['running', 'waiting'].includes(task.status)) pauseUploadTask(task)
  }
  for (const task of transfers.downloads) {
    if (task.isPrivate && ['running', 'waiting'].includes(task.status)) pauseDownloadTask(task)
  }
  renderTransferPanel()
}

function pauseAllVisibleTransfers() {
  const tasks = (transfers.activeTab === 'upload' ? transfers.uploads : transfers.downloads)
    .filter(transferIsVisible)
  for (const task of tasks) {
    if (task.status === 'running' || task.status === 'waiting') {
      if (task.kind === 'upload') pauseUploadTask(task)
      else pauseDownloadTask(task)
    }
  }
  renderTransferPanel()
}

async function resumeAllVisibleTransfers() {
  const { notify } = host()
  const tasks = (transfers.activeTab === 'upload' ? transfers.uploads : transfers.downloads)
    .filter(transferIsVisible)
  let skipped = 0
  for (const task of tasks) {
    if (!['paused', 'failed'].includes(task.status) || !transferCanRetry(task)) continue
    if (task.kind === 'upload' && !task.file) {
      skipped += 1
      continue
    }
    if (task.kind === 'download' && task.pendingPermission) {
      skipped += 1
      continue
    }
    if (task.kind === 'upload') await resumeUploadTask(task)
    else startDownloadRun(task)
  }
  if (skipped) notify(`有 ${skipped} 个任务需要先选择原文件或授予保存权限`)
}

function clearCompletedVisibleTransfers() {
  const isUpload = transfers.activeTab === 'upload'
  const list = isUpload ? transfers.uploads : transfers.downloads
  const removed = list.filter((task) => transferIsVisible(task) && TERMINAL_TRANSFER_STATUSES.has(task.status))
  if (!isUpload) {
    for (const task of removed) void removeDownloadHandle(task.id)
  }
  const kept = list.filter((task) => !removed.includes(task))
  if (isUpload) transfers.uploads = kept
  else transfers.downloads = kept
  if (isUpload) persistUploadTasks()
  else persistDownloadTasks()
  renderTransferPanel()
}

function bindTransferApp() {
  const { $, $$, state, renderGrid, renderLoadMore } = host()
  $('#transfer-btn').addEventListener('click', openTransferView)
  $$('[data-transfer-tab]').forEach((button) => {
    button.addEventListener('click', () => setTransferTab(button.dataset.transferTab))
  })
  $('#transfer-pause-all').addEventListener('click', pauseAllVisibleTransfers)
  $('#transfer-resume-all').addEventListener('click', () => { void resumeAllVisibleTransfers() })
  $('#transfer-clear-done').addEventListener('click', clearCompletedVisibleTransfers)
  $('#transfer-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-transfer-action]')
    if (!button) return
    void handleTransferAction(
      button.dataset.transferKind,
      button.dataset.transferId,
      button.dataset.transferAction,
    )
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.transferMode) return
    if (event.target && event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
    leaveTransferView()
    renderGrid()
    renderLoadMore()
  })
}

window.VaultTransfers = {
  uploadFiles: enqueueUploadFiles,
  startDownload: startRecordDownload,
  restore: restoreTransferTasks,
  pauseForAuth: pauseTransfersForAuth,
  pausePrivate: pausePrivateTransfers,
  render: renderTransferPanel,
  leave: leaveTransferView,
}

bindTransferApp()