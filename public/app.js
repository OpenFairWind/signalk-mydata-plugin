// Import helper utilities for formatting numbers, calculating distances/bearings, downloading text, and parsing/serializing formats.
import { haversineNm, bearingDeg, fmt, downloadText, parseCSV, toCSV, parseGPX, toGPX, parseKML, toKML, parseGeoJSON, toGeoJSON } from './formats.js'
// Shorthand query selector helper to keep DOM lookups concise.
const $ = (sel) => document.querySelector(sel)

// Constant for plugin identification inside URLs.
const PLUGIN_ID = 'signalk-mydata-plugin'
// Base path for plugin-relative API endpoints.
const API_BASE = `/plugins/${PLUGIN_ID}`
// Endpoint for Signal K login status.
const LOGIN_STATUS_ENDPOINT = '/skServer/loginStatus'

// Global application state for resources, selection, vessel position, and icons.
const state = {
  // Current active tab.
  tab: 'waypoints',
  // Pagination tracking per tab.
  page: { waypoints: 1, routes: 1, files: 1 },
  // Dynamic page size per tab computed from viewport.
  pageSize: { waypoints: 8, routes: 8, files: 8 },
  // Cached resources keyed by type.
  resources: { waypoints: {}, routes: {}, tracks: {} },
  // Currently rendered list items for the active tab.
  list: [],
  // Selected resource ids in a Set of "type:id" keys.
  selected: new Set(),
  // Latest vessel position from websocket updates.
  vesselPos: null,
  // Icon manifest fetched at boot.
  icons: null,
  waypointsTypes: null,
  skIcons: null,
  config: {
    coordinateFormat: 'dd',
    distanceUnit: 'nm',
    depthUnit: 'm',
    waypointPropertyViews: [],
    fileRoots: []
  },
  notesByWaypoint: new Map(),
  noteView: { waypointId: null, notes: [], index: 0 },
  // Mapping from resource key to DOM row for incremental updates.
  rows: new Map(),
  // Auth metadata from Signal K login status.
  auth: { status: null, userLevel: null },
  // Detail panel state.
  detail: { item: null, edit: false, preview: null, isNew: false }
}
// Track long-running operations with optional abort handles.
const progress = {
  controller: null,
  current: null
}

// UI helpers for showing/hiding overlay progress bar.
function showProgress(text, { indeterminate = true } = {}) {
  const overlay = $('#progressOverlay')
  const txt = $('#progressText')
  const fill = $('#progressFill')
  if (!overlay || !txt || !fill) return
  overlay.classList.remove('hidden')
  overlay.setAttribute('aria-busy', 'true')
  txt.textContent = text || 'Working…'
  fill.style.width = indeterminate ? '25%' : '0%'
  fill.classList.toggle('progress__fill--indeterminate', indeterminate)
}

function updateProgress(percent, text) {
  const fill = $('#progressFill')
  const txt = $('#progressText')
  if (!fill || !txt) return
  if (text) txt.textContent = text
  const pct = Math.max(0, Math.min(100, percent))
  fill.style.width = `${pct}%`
  fill.classList.remove('progress__fill--indeterminate')
}

function hideProgress() {
  const overlay = $('#progressOverlay')
  const fill = $('#progressFill')
  if (!overlay || !fill) return
  overlay.classList.add('hidden')
  overlay.removeAttribute('aria-busy')
  fill.style.width = '0%'
  fill.classList.remove('progress__fill--indeterminate')
  progress.controller = null
  progress.current = null
}

function beginProgress(text, opts = {}) {
  const ctrl = new AbortController()
  progress.controller = ctrl
  progress.current = opts.key || null
  showProgress(text, opts)
  return ctrl
}

function cancelProgress() {
  if (progress.controller?.abort) progress.controller.abort()
  hideProgress()
  setStatus('Operation cancelled', false)
}

// Attach cancel handler for progress overlay.
$('#btnCancelProgress')?.addEventListener('click', cancelProgress)
// Websocket monitor handles.
const WS_CHECK_INTERVAL = 7000
let liveSocket = null
let liveSocketMonitor = null
// Helper to build fully qualified Signal K v2 resource endpoints.
const RES_ENDPOINT = (type) => `/signalk/v2/api/resources/${type}`

// Verify write access before attempting server mutations.
async function fetchLoginStatus({ silent = false } = {}) {
  try {
    const res = await fetch(LOGIN_STATUS_ENDPOINT, { cache: 'no-cache' })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Login status failed: ${res.status}`)
    state.auth.status = j.status || null
    state.auth.userLevel = j.userLevel || null
    return { ok: true, status: state.auth.status, userLevel: state.auth.userLevel }
  } catch (e) {
    if (!silent) setStatus(e.message || String(e), false)
    return { ok: false, error: e }
  }
}

async function ensureWriteAccess() {
  const status = await fetchLoginStatus()
  if (!status.ok) return false
  if (status.status === 'notLoggedIn' || status.userLevel === 'readonly') {
    alert('Read-only access detected. Please log in to make changes.')
    setStatus('Read-only access: log in to make changes.', false)
    return false
  }
  return true
}

// Generate a UUID for resource identifiers with Date fallback.
function genUuid() {
  if (crypto?.randomUUID) return crypto.randomUUID()
  const t = Date.now().toString(16)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  }) + '-' + t.slice(-4)
}

// Attach cancel handler for progress overlay.
$('#btnCancelProgress')?.addEventListener('click', () => hideProgress())

// State dedicated to remote file operations and editors.
const filesState = {
  // Current remote path (relative to configured root).
  remotePath: '',
  // Entries returned by the server for the current path.
  remoteEntries: [],
  // Currently selected remote file path (relative).
  selectedRemote: null,
  // Active file root id.
  rootId: 'default',
  // TinyMCE editor instances keyed by selector.
  // Using a Map lets us run multiple editors (e.g., Files + Waypoint Description + Properties)
  // without clobbering a single global instance.
  tinyEditors: new Map()
}

// Human-friendly formatting for byte sizes.
function humanSize(bytes) {
  // Return early for empty inputs.
  if (bytes == null) return ''
  // Available units from bytes up to gigabytes.
  const units = ['B','KB','MB','GB']
  // Normalize to a number.
  let b = Number(bytes)
  // Selected unit index.
  let u = 0
  // Iterate through units while size is large.
  while (b >= 1024 && u < units.length-1) { b /= 1024; u++ }
  // Format with precision depending on unit.
  return `${b.toFixed(u===0?0:1)} ${units[u]}`
}

// Utility to toggle .hidden class on arbitrary elements.
function setHidden(el, hidden) {
  // Guard for null references.
  if (!el) return
  // Toggle visibility via CSS class.
  el.classList.toggle('hidden', hidden)
}

function hasFileRoots() {
  return Array.isArray(state.config.fileRoots) && state.config.fileRoots.length > 0
}

function nmToKm(nm) {
  return nm * 1.852
}

function metersToUnit(meters, unit) {
  if (meters == null || Number.isNaN(meters)) return null
  if (unit === 'ft') return meters * 3.28084
  if (unit === 'fathom') return meters / 1.8288
  return meters
}

function metersFromUnit(value, unit) {
  if (value == null || Number.isNaN(value)) return null
  if (unit === 'ft' || unit === 'feet') return value / 3.28084
  if (unit === 'fathom' || unit === 'fathoms') return value * 1.8288
  return value
}

function distanceUnitLabel(unit) {
  return unit === 'km' ? 'KM' : 'NM'
}

function depthUnitLabel(unit) {
  if (unit === 'ft') return 'FT'
  if (unit === 'fathom') return 'FATH'
  return 'M'
}

function distanceForDisplay(nm) {
  if (nm == null) return null
  return state.config.distanceUnit === 'km' ? nmToKm(nm) : nm
}

function formatDistance(nm) {
  const val = distanceForDisplay(nm)
  if (val == null) return '—'
  return fmt(val, 2)
}

function formatBearing(brg) {
  if (brg == null) return '—'
  return fmt(brg, 0)
}

function formatCoordinate(value, format, hemi) {
  if (value == null || Number.isNaN(value)) return '—'
  const abs = Math.abs(Number(value))
  if (format === 'dm') {
    const deg = Math.floor(abs)
    const min = (abs - deg) * 60
    return `${deg}° ${fmt(min, 3)}' ${hemi}`
  }
  if (format === 'dms') {
    const deg = Math.floor(abs)
    const minFloat = (abs - deg) * 60
    const min = Math.floor(minFloat)
    const sec = (minFloat - min) * 60
    return `${deg}° ${min}' ${fmt(sec, 2)}" ${hemi}`
  }
  return `${fmt(abs, 6)}° ${hemi}`
}

function formatLatLon(lat, lon) {
  const fmtType = state.config.coordinateFormat || 'dd'
  const latHemi = lat >= 0 ? 'N' : 'S'
  const lonHemi = lon >= 0 ? 'E' : 'W'
  return {
    lat: formatCoordinate(lat, fmtType, latHemi),
    lon: formatCoordinate(lon, fmtType, lonHemi)
  }
}

// Initialize (or reuse) a TinyMCE editor for a given selector and return the instance.
// Initialize TinyMCE editor once per selector and return the instance.
// Pedagogical note:
// - We keep a Map<selector, editor> so multiple editors can exist at once.
// - We add a small content_style:
//   * .tm-line      -> pre-wrap (nice for prose)
//   * .tm-code-line -> pre (exact spacing, monospace; good for JSON)
async function ensureTiny(selector = '#detailTextEditor') {
  if (!filesState.tinyEditors) filesState.tinyEditors = new Map()
  if (filesState.tinyEditors.has(selector)) return filesState.tinyEditors.get(selector)
  if (!window.tinymce) throw new Error('TinyMCE not loaded')

  const content_style = `
    .tm-line { white-space: pre-wrap; }
    .tm-code-line {
      white-space: pre;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 13px;
    }
    body { margin: 8px; }
  `

  const [inst] = await tinymce.init({
    selector,
    menubar: false,
    toolbar: 'undo redo | bold italic underline | bullist numlist | alignleft aligncenter alignright | removeformat',
    height: '100%',
    min_height: 320,
    skin: 'oxide-dark',
    content_css: 'dark',
    content_style
  })

  filesState.tinyEditors.set(selector, inst)
  return inst
}

// Remove a TinyMCE editor instance for a selector (if any).
function removeTiny(selector) {
  const inst = filesState.tinyEditors?.get?.(selector)
  if (inst?.remove) inst.remove()
  filesState.tinyEditors?.delete?.(selector)
}

// Remove all TinyMCE editors (used when closing/refreshing the detail panel).
function removeAllTinies() {
  if (!filesState.tinyEditors) return
  for (const inst of filesState.tinyEditors.values()) {
    if (inst?.remove) inst.remove()
  }
  filesState.tinyEditors.clear()
}


// Helper to set text editor content.
// Helper to set TinyMCE editor content from plain text.
// - Used for: file editor, waypoint description editor, waypoint properties (JSON) editor.
// - Important: we keep content as simple <div> lines so TinyMCE behaves predictably.
async function setTextEditorValue(text, selector = '#detailTextEditor') {
  try {
    const ed = await ensureTiny(selector)

    // Decide the CSS class to apply to each line.
    // Pedagogical note:
    // - For JSON editors we want *monospace* + *pre* (exact spacing).
    // - For normal text editors we can use pre-wrap (nice wrapping).
    const isJson = selector === '#detailWpPropsEditor'
    const lineClass = isJson ? 'tm-code-line' : 'tm-line'

    // 1) Split into lines using '\n' (works for both LF and CRLF after normalization).
    const lines = (text || '').replace(/\r\n/g, '\n').split('\n')

    // 2) Escape HTML special chars so user text cannot inject markup.
    const escape = (s) => (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')

    // 3) Wrap each line in a div. For empty lines we insert <br> to keep a visible line.
    const html = lines.map((line) => {
      const safe = escape(line)
      return `<div class="${lineClass}">${safe || '<br>'}</div>`
    }).join('') || `<div class="${lineClass}"><br></div>`

    ed.setContent(html)
  } catch (e) {
    // Fallback: if TinyMCE isn't available, write to the underlying textarea.
    const el = document.querySelector(selector)
    if (el) el.value = text || ''
  }
}


// Helper to get text editor content as plain text.
// Helper to get TinyMCE content as plain text.
// Pedagogical note:
// - TinyMCE may emit NBSP (\u00A0) depending on editing actions.
// - JSON.parse does *not* treat NBSP as whitespace, so we normalize it.
function getTextEditorValue(selector = '#detailTextEditor') {
  const ed = filesState.tinyEditors?.get?.(selector)
  const raw = ed ? (ed.getContent({ format: 'text' }) || '') : ((document.querySelector(selector)?.value) || '')

  return raw
      .replace(/\u00A0/g, ' ')   // NBSP -> space
      .replace(/\u202F/g, ' ')   // narrow NBSP -> space
      .replace(/\r\n/g, '\n')  // Windows newlines -> \n
}

// Determine if a MIME type is previewable inline.
function isPreviewableMime(mime) {
  // Guard against falsy values and check known prefixes.
  return mime && (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/pdf')
}

// Build a binary preview node depending on MIME and data.
function previewBinary(mime, data) {
  // Wrapper for all binary previews.
  const wrap = document.createElement('div')
  // Assign base class for styling.
  wrap.className = 'preview__binary'
  // Fallback when data is missing.
  if (!mime || !data) {
    wrap.textContent = 'Binary file — use Download'
    wrap.classList.add('muted')
    return wrap
  }

  // Construct a data URL for media elements.
  const dataUrl = `data:${mime};base64,${data}`
  // Image preview block.
  if (mime.startsWith('image/')) {
    const img = new Image()
    img.src = dataUrl
    img.alt = 'Preview'
    img.className = 'preview__media'
    wrap.appendChild(img)
    return wrap
  }
  // Audio preview block.
  if (mime.startsWith('audio/')) {
    const audio = document.createElement('audio')
    audio.controls = true
    audio.src = dataUrl
    audio.style.width = '100%'
    wrap.appendChild(audio)
    return wrap
  }
  // Video preview block.
  if (mime.startsWith('video/')) {
    const video = document.createElement('video')
    video.controls = true
    video.src = dataUrl
    video.style.width = '100%'
    video.style.maxHeight = '200px'
    wrap.appendChild(video)
    return wrap
  }
  // PDF preview block.
  if (mime === 'application/pdf') {
    const iframe = document.createElement('iframe')
    iframe.src = dataUrl
    iframe.className = 'preview__frame'
    wrap.appendChild(iframe)
    return wrap
  }
  // Generic fallback for unknown binaries.
  wrap.textContent = 'Binary file — use Download'
  wrap.classList.add('muted')
  return wrap
}

// Fetch a remote directory listing and update UI state.
function activeFileRootId() {
  if (!hasFileRoots()) return null
  return filesState.rootId || state.config.fileRoots[0]?.id || null
}

function fileRootLabel(rootId) {
  return state.config.fileRoots.find(root => root.id === rootId)?.label || rootId || ''
}

function buildFileQuery(pathRel, rootId) {
  const params = new URLSearchParams()
  if (pathRel) params.set('path', pathRel)
  if (rootId) params.set('root', rootId)
  const query = params.toString()
  return query ? `?${query}` : ''
}

async function remoteList(pathRel = '', rootId = activeFileRootId()) {
  if (!hasFileRoots()) throw new Error('Files panel disabled (no file roots configured).')
  // Request listing from server.
  const res = await fetch(`${API_BASE}/files/list${buildFileQuery(pathRel, rootId)}`)
  // Parse JSON payload.
  const j = await res.json()
  // Throw on failure so caller can surface status.
  if (!res.ok || !j.ok) throw new Error(j.error || `List failed: ${res.status}`)
  // Persist path and entries for rendering.
  filesState.remotePath = j.path || ''
  filesState.rootId = j.root || rootId
  filesState.remoteEntries = j.entries || []
  filesState.selectedRemote = null
  state.page.files = 1
  // Render file panels to reflect new state.
  if (state.tab === 'files') render()
}

// Render breadcrumb text for remote navigation.
function renderCrumbs() {
  // Normalize remote path for display.
  const p = filesState.remotePath || ''
  const rootLabel = fileRootLabel(activeFileRootId())
  // Show root indicator when empty.
  return p ? `${rootLabel}: / ${p}` : `${rootLabel}: / (root)`
}

const TEXT_FILE_TYPES = {
  text: {
    label: 'Plain text',
    ext: 'txt',
    mime: 'text/plain',
    skeleton: ''
  },
  html: {
    label: 'HTML',
    ext: 'html',
    mime: 'text/html',
    skeleton: '<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n  <title>New Document</title>\n</head>\n<body>\n  <h1>Hello</h1>\n</body>\n</html>\n'
  },
  json: {
    label: 'JSON',
    ext: 'json',
    mime: 'application/json',
    skeleton: '{\n  \"name\": \"New Document\"\n}\n'
  },
  xml: {
    label: 'XML',
    ext: 'xml',
    mime: 'application/xml',
    skeleton: '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<root>\n  <item>New Document</item>\n</root>\n'
  },
  md: {
    label: 'MD',
    ext: 'md',
    mime: 'text/markdown',
    skeleton: '# New Document\n\nStart writing here.\n'
  }
}

function fileSizeFromText(text) {
  if (!text) return 0
  if (window.TextEncoder) return new TextEncoder().encode(text).length
  return text.length
}

function buildFileMeta(item, preview) {
  if (preview?.meta) return preview.meta
  const mime = preview?.mime || (item?.fileType === 'dir' ? 'directory' : 'text/plain')
  const size = preview?.size ?? item?.size ?? fileSizeFromText(preview?.text || '')
  const parts = [item?.id || '', mime, size ? humanSize(size) : '0 B'].filter(Boolean)
  return parts.join(' • ')
}

function isTextPreview(preview, editMode, isNew) {
  return preview?.kind === 'text' || editMode || isNew
}

function isBinaryPreview(preview) {
  return preview?.kind === 'binary' && preview.data && isPreviewableMime(preview.mime)
}

// Render the remote file list with selection support.
// Helper to build a relative path with the current directory prefix.
function buildRelPath(name) {
  // Trim trailing slashes from current path.
  const base = filesState.remotePath ? (filesState.remotePath.replace(/\/+$/,'') + '/') : ''
  // Join base with provided name.
  return base + name
}

// Display remote file preview content and track mime for editor choices.
async function remotePreview(relPath, rootId = activeFileRootId()) {
  try {
    // Request file preview payload.
    const res = await fetch(`${API_BASE}/files/read${buildFileQuery(relPath, rootId)}`)
    // Parse JSON body.
    const j = await res.json()
    // Throw friendly error when request fails.
    if (!res.ok || !j.ok) throw new Error(j.error || `Read failed: ${res.status}`)
    // Remember selected path and mime for follow-up actions.
    // Build metadata string for display.
    const meta = `${relPath} • ${j.mime || j.kind} • ${humanSize(j.size)}`
    filesState.selectedRemote = relPath
    return { ...j, meta }
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
}

// Render the files view (breadcrumbs, list, preview, and editor buttons).
// Move up one directory level when possible.
async function remoteUp() {
  // Normalize current path removing trailing slashes.
  const p = (filesState.remotePath || '').replace(/\/+$/,'')
  // Do nothing at root.
  if (!p) return
  // Split into segments and drop the last.
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  // Navigate to parent directory.
  await remoteList(parts.join('/'))
}

// Prompt for a new folder name and create it remotely.
async function remoteMkdir() {

  // Ensure write access
  if (!await ensureWriteAccess()) return

  // Ask the user for a folder name.
  const name = prompt('New folder name:')
  // Abort when cancelled or empty.
  if (!name) return



  // Compose relative path for creation.
  const rel = buildRelPath(name)
  // Issue mkdir request.
  const res = await fetch(`${API_BASE}/files/mkdir`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: rel, root: activeFileRootId() }) })
  // Parse JSON response.
  const j = await res.json().catch(() => ({}))
  // Surface errors via status bar.
  if (!res.ok || !j.ok) { setStatus(j.error || `mkdir failed: ${res.status}`, false); return }
  // Refresh listing on success.
  await remoteList(filesState.remotePath)
}

// Upload one or more files directly into the current remote directory.
async function remoteUpload(files) {

  // Ensure write access
  if (!await ensureWriteAccess()) return

  // Ignore when nothing selected.
  if (!files || !files.length) return

  const ctrl = beginProgress('Uploading files…')
  // Prepare multipart form data.
  const fd = new FormData()
  // Append directory path.
  fd.append('dir', filesState.remotePath || '')
  fd.append('root', activeFileRootId())
  // Append every file using shared field name.
  for (const f of files) fd.append('file', f, f.name)
  // POST to upload endpoint.
  try {
    const res = await fetch(`${API_BASE}/files/upload`, { method:'POST', body: fd, signal: ctrl.signal })
    // Parse JSON reply.
    const j = await res.json().catch(() => ({}))
    // Signal errors in UI.
    if (!res.ok || !j.ok) throw new Error(j.error || `upload failed: ${res.status}`)
    // Inform user of success and refresh listing.
    setStatus('Uploaded ✔', true)
    await remoteList(filesState.remotePath)
  } catch (e) {
    if (ctrl.signal.aborted) setStatus('Upload cancelled', false)
    else setStatus(e.message || String(e), false)
  } finally {
    hideProgress()
  }
}

function defaultFileNameForType(typeKey) {
  const type = TEXT_FILE_TYPES[typeKey] || TEXT_FILE_TYPES.text
  return `new-file.${type.ext}`
}

function ensureFileExtension(name, typeKey) {
  const type = TEXT_FILE_TYPES[typeKey] || TEXT_FILE_TYPES.text
  const base = name.trim()
  if (!base) return defaultFileNameForType(typeKey)
  const last = base.split('/').pop() || base
  if (last.includes('.')) return base
  return `${base}.${type.ext}`
}

async function openNewFileDialog() {
  const dlg = $('#dlgNewFile')
  const nameField = $('#newFileName')
  const typeField = $('#newFileType')
  if (!dlg || !nameField || !typeField) return
  nameField.value = defaultFileNameForType(typeField.value || 'text')
  dlg.showModal()
}

async function createNewTextFile() {
  const nameField = $('#newFileName')
  const typeField = $('#newFileType')
  if (!nameField || !typeField) return
  const typeKey = typeField.value || 'text'
  const type = TEXT_FILE_TYPES[typeKey] || TEXT_FILE_TYPES.text
  const rel = buildRelPath(ensureFileExtension(nameField.value, typeKey))
  const preview = {
    kind: 'text',
    text: type.skeleton,
    mime: type.mime,
    size: fileSizeFromText(type.skeleton),
    meta: `${rel} • ${type.mime} • ${humanSize(fileSizeFromText(type.skeleton))}`
  }
  const item = { type: 'files', id: rel, name: rel.split('/').pop(), fileType: 'file', size: preview.size, modified: null, description: '', raw: { name: rel.split('/').pop(), type: 'file' } }
  await openDetail(item, { edit: true, isNew: true, preview })
}

// Create or overwrite a text file on the server.
async function remoteSaveText(pathRel, text) {
  if (!await ensureWriteAccess()) return false
  // Issue write request with utf8 encoding.
  const res = await fetch(`${API_BASE}/files/write`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, content: text, encoding: 'utf8', root: activeFileRootId() }) })
  // Parse response JSON for ok flag.
  const j = await res.json().catch(() => ({}))
  // Raise user-visible error on failure.
  if (!res.ok || !j.ok) { setStatus(j.error || `Save failed: ${res.status}`, false); return false }
  // Inform success.
  setStatus('Saved ✔', true)
  return true
}

// Download a remote file or directory (as zip) with cancel support.
async function remoteDownload(pathRel) {
  const ctrl = beginProgress('Downloading…')
  try {
    const res = await fetch(`${API_BASE}/files/download${buildFileQuery(pathRel, activeFileRootId())}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`Download failed: ${res.status}`)
    const blob = await res.blob()
    const disp = res.headers.get('Content-Disposition') || ''
    const m = /filename=\"?([^\";]+)\"?/i.exec(disp)
    const name = m?.[1] || pathRel.split('/').pop() || 'download'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setStatus('Download started ✔', true)
  } catch (e) {
    if (ctrl.signal.aborted) setStatus('Download cancelled', false)
    else setStatus(e.message || String(e), false)
  } finally {
    hideProgress()
  }
}

// Rename a remote file by supplying new path.
async function remoteRename(pathRel, newName) {
  if (!await ensureWriteAccess()) return false
  // Compute new relative path in current directory.
  const newRel = buildRelPath(newName)
  // Perform rename via dedicated endpoint.
  const res = await fetch(`${API_BASE}/files/rename`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, newPath: newRel, root: activeFileRootId() }) })
  // Parse response payload.
  const j = await res.json().catch(() => ({}))
  // Handle errors gracefully.
  if (!res.ok || !j.ok) { setStatus(j.error || `Rename failed: ${res.status}`, false); return false }
  // Update selection and refresh list.
  filesState.selectedRemote = newRel
  await remoteList(filesState.remotePath)
  return true
}

// Move a remote file to an arbitrary path.
async function remoteMove(pathRel) {

  // Ensure write access
  if (!await ensureWriteAccess()) return null

  const dest = prompt('Move to path (relative to root):', pathRel)
  if (!dest || dest === pathRel) return null

  const res = await fetch(`${API_BASE}/files/rename`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, newPath: dest, root: activeFileRootId() }) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ok) { setStatus(j.error || `Move failed: ${res.status}`, false); return null }
  filesState.selectedRemote = dest
  await remoteList(filesState.remotePath)
  return dest
}

// Delete a remote file using server endpoint.
async function remoteDelete(pathRel, confirmDelete = true) {

  // Ensure write access
  if (!await ensureWriteAccess()) return false

  // Prompt user for confirmation.
  if (confirmDelete && !confirm(`Delete remote file "${pathRel}"?`)) return false

  // Send delete request.
  const res = await fetch(`${API_BASE}/files/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, root: activeFileRootId() }) })
  // Parse JSON reply.
  const j = await res.json().catch(() => ({}))
  // Notify on errors.
  if (!res.ok || !j.ok) { setStatus(j.error || `Delete failed: ${res.status}`, false); return false }
  // Clear selection and refresh listing.
  filesState.selectedRemote = null
  await remoteList(filesState.remotePath)
  return true
}

// Update status text with optional success flag.
function setStatus(text, ok = true) {
  // Find status element.
  const el = $('#status')
  if (!el) return
  // Write provided text.
  el.textContent = text
  // Colorize based on success flag.
  el.style.color = ok ? 'var(--muted)' : 'var(--danger)'
}

async function loadConfig() {

  try {

    const res = await fetch(`${API_BASE}/config`, { cache: 'no-cache' })
    const j = await res.json()

    if (!res.ok) throw new Error(`Config failed: ${res.status}`)

    const cfg = j.configuration || {}

    state.config.coordinateFormat = cfg.coordinateFormat || 'dd'
    state.config.distanceUnit = cfg.distanceUnit || 'nm'
    state.config.depthUnit = cfg.depthUnit || 'm'
    state.config.waypointPropertyViews = Array.isArray(cfg.waypointPropertyViews) ? cfg.waypointPropertyViews : []
    state.config.fileRoots = Array.isArray(cfg.fileRoots) ? cfg.fileRoots : []
    if (state.config.fileRoots.length && !state.config.fileRoots.find(root => root.id === filesState.rootId)) {
      filesState.rootId = state.config.fileRoots[0].id
    }

    if (!state.config.fileRoots.length) filesState.rootId = null
    updateConfigLabels()
    updateFileRootSelect()
    updateFilePanelVisibility()
  } catch (e) {
    setStatus(e.message || String(e), false)
  }
}

function updateConfigLabels() {
  const withinLabel = $('#filterWithinLabel')
  if (withinLabel) withinLabel.textContent = `Within (${distanceUnitLabel(state.config.distanceUnit)})`
}

function updateFileRootSelect() {
  const select = $('#fileRootSelect')
  if (!select) return
  select.innerHTML = ''
  const roots = state.config.fileRoots.length ? state.config.fileRoots : []
  for (const root of roots) {
    const opt = document.createElement('option')
    opt.value = root.id
    opt.textContent = root.label || root.id
    if (root.id === filesState.rootId) opt.selected = true
    select.appendChild(opt)
  }
}

function updateFilePanelVisibility() {
  const filesTab = document.querySelector('.segmented__btn[data-tab="files"]')
  const enabled = hasFileRoots()
  setHidden(filesTab, !enabled)
}

// Load OpenBridge icon manifest and wire select options/mask images.
async function loadIcons() {
  // Fetch manifest with cache busting.
  const res = await fetch('./icons.json', { cache: 'no-cache' })
  // Store manifest JSON.
  state.icons = await res.json()

  // Apply mask images to static icon placeholders.
  document.querySelectorAll('.icon[data-icon]').forEach((el) => {
    const id = el.getAttribute('data-icon')
    const ic = state.icons.icons.find(x => x.id === id)
    if (!ic) return
    const url = state.icons.baseUrl + ic.path
    el.style.webkitMaskImage = `url(${url})`
    el.style.maskImage = `url(${url})`
  })
}

// Load Signal K icon manifest used for icon overrides.
async function loadSkIcons() {
  // Fetch manifest with cache busting.
  const res = await fetch('./skicons.json', { cache: 'no-cache' })
  // Store manifest JSON.
  state.skIcons = await res.json()

  const sel = $('#editIconOverride')
  if (sel) {
    sel.innerHTML = ''
    const blank = document.createElement('option')
    blank.value = ''
    blank.textContent = '— none —'
    sel.appendChild(blank)
    for (const ic of state.skIcons.icons) {
      const o = document.createElement('option')
      o.value = ic.id
      o.textContent = ic.label
      sel.appendChild(o)
    }
  }
}

// Load waypoint type manifest used for dropdowns and defaults.
async function loadWaypointTypes() {
  // Fetch manifest with cache busting.
  const res = await fetch('./waypoints.json', { cache: 'no-cache' })
  // Store manifest JSON.
  state.waypointsTypes = await res.json()

  // Populate select elements for filter and edit dialogs.
  for (const sel of [$('#filterType'), $('#editType')]) {
    sel.innerHTML = ''
    const optAny = document.createElement('option')
    optAny.value = ''
    optAny.textContent = sel.id === 'filterType' ? 'Any' : '— choose —'
    sel.appendChild(optAny)

    for (const ic of state.waypointsTypes.icons) {
      const o = document.createElement('option')
      o.value = ic.id
      o.textContent = ic.label
      sel.appendChild(o)
    }
  }
}

// Fetch resources of the given type and cache them.
async function fetchResources(type) {
  // Request collection using v2 endpoint.
  const res = await fetch(RES_ENDPOINT(type), { cache: 'no-cache' })
  // Throw when HTTP status indicates failure.
  if (!res.ok) throw new Error(`Fetch ${type} failed: ${res.status}`)
  // Assign parsed JSON into cache.
  state.resources[type] = await res.json() || {}
}

// Normalize resource objects into list-friendly shape.
function normalizeResource(type, id, obj) {
  // Base item with type, id, and raw data for edits.
  const item = { type, id, raw: obj }
  // Prefer human-readable fields for name/description.
  item.name = obj.name || obj.title || id
  item.description = obj.description || obj.note || ''
  const wpProps = type === 'waypoints' ? extractWaypointMeta(obj) : {}
  item.icon = wpProps.icon || ''
  item.wpType = wpProps.type || ''
  if (!item.wpType && type === 'waypoints') item.wpType = 'waypoint'
  item.skIcon = wpProps.skIcon || ''
  if (!item.icon && type === 'waypoints') item.icon = iconForType(item.wpType) || 'waypoint'
  item.updated = obj.timestamp || obj.updated || obj.modified || obj.created || null

  // Extract waypoint position when available.
  if (type === 'waypoints') {
    item.position = obj.position || (obj.feature?.geometry?.type === 'Point'
        ? { latitude: obj.feature.geometry.coordinates[1], longitude: obj.feature.geometry.coordinates[0] }
        : null)
  }
  // Return normalized record for rendering.
  return item
}

// Return available icon catalogs (UI + waypoint type lists).
function iconCatalogs() {
  return [state.waypointsTypes, state.skIcons, state.icons].filter(Boolean)
}

// Find a specific icon in the provided catalog and include base URL metadata.
function findIconInCatalog(catalog, iconId) {
  if (!iconId || !catalog?.icons) return null
  const ic = catalog.icons.find(x => x.id === iconId)
  return ic ? { ...ic, baseUrl: catalog.baseUrl || '' } : null
}

// Map waypoint type to preferred icon id.
function iconForType(type) {
  if (!type) return null
  const exists = getIconMeta(type)
  return exists ? type : null
}

// Extract waypoint type/skIcon/icon metadata.
function extractWaypointMeta(obj = {}) {
  const props = obj.properties || obj.feature?.properties || {}
  const type = props.type || obj.type || ''
  const skIcon = props.skIcon || ''
  const explicitIcon = props.icon || obj.icon || ''
  const resolved = skIcon || iconForType(type) || explicitIcon || ''
  return { type, skIcon, icon: resolved }
}

// Compute derived metrics (distance/bearing) based on vessel position.
function computeDerived(item) {
  // Only compute when both vessel and waypoint positions are known.
  if (state.vesselPos && item.position) {
    const { latitude: lat1, longitude: lon1 } = state.vesselPos
    const { latitude: lat2, longitude: lon2 } = item.position
    item.distanceNm = haversineNm(lat1, lon1, lat2, lon2)
    item.bearing = bearingDeg(lat1, lon1, lat2, lon2)
  } else {
    item.distanceNm = null
    item.bearing = null
  }
}

// Build a waypoint payload including GeoJSON feature metadata.
function buildWaypointPayload({ id, name, description, type, position, properties = {}}) {

  /*
  {
  "e16fe805-f76e-43e1-826d-dfec1f0b4fd3": {
    "name": "Wpt-73916",
    "description": "A waypoint",
    "feature": {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [
          23.44317218974258,
          59.989769061119716
        ]
      },
      "properties": {
        "skIcon": "virtual-north"
      },
      "id": ""
    },
    "type": "pseudoaton",
    "timestamp": "2026-01-08T21:28:11.867Z",
    "$source": "resources-provider"
  }
}
   */

  const payload = {}
  if (id) payload.id = id
  if (name !== undefined) payload.name = name
  if (description !== undefined) payload.description = description
  if (type !== undefined) payload.type = type

  const lat = Number(position?.latitude)
  const lon = Number(position?.longitude)
  const hasCoords = !Number.isNaN(lat) && !Number.isNaN(lon)

  if (hasCoords) {

    payload.feature = {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [ lon,  lat ]
      },
      "properties": properties,
      "id": ""
    }
  }

  return payload
}

// Return list of items for the current tab.
function getItemsForTab() {
  // Capture active tab key.
  const tab = state.tab
  if (tab === 'files') {
    return (filesState.remoteEntries || []).map((e) => ({
      type: 'files',
      id: buildRelPath(e.name),
      name: e.name,
      description: e.type === 'dir' ? 'Directory' : '',
      fileType: e.type,
      size: e.size,
      modified: e.mtime,
      raw: e
    }))
  }
  // Find resource map for that tab.
  const r = state.resources[tab] || {}
  // Convert entries into normalized items.
  return Object.entries(r).map(([id, obj]) => normalizeResource(tab, id, obj))
}

// Apply filters from UI controls to a provided list.
function applyFilters(list) {
  // Acquire search string.
  const q = ($('#filterText').value || '').trim().toLowerCase()
  // Parse numeric filter for distance.
  const withinInput = state.tab === 'files' ? NaN : parseFloat($('#filterWithinNm').value || '')
  const within = Number.isNaN(withinInput) ? NaN : (state.config.distanceUnit === 'km' ? (withinInput / 1.852) : withinInput)
  // Icon filter selection.
  const icon = state.tab === 'files' ? '' : ($('#filterType').value || '').trim()

  // Filter list based on conditions.
  return list.filter(it => {
    if (q) {
      const hay = `${it.name} ${it.description} ${it.id}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (icon && (it.icon || '') !== icon) return false
    if (!Number.isNaN(within) && within > 0) {
      if (it.distanceNm == null || it.distanceNm > within) return false
    }
    return true
  })
}

// Apply sorting based on UI selection.
function applySort(list) {
  // Sorting key.
  const key = $('#sortBy').value
  // Sorting order.
  const order = $('#sortOrder').value
  // Direction multiplier.
  const dir = order === 'asc' ? 1 : -1
  // Selector for values based on key.
  const getv = (it) => {
    if (state.tab === 'files') {
      if (key === 'size') return it.size ?? 0
      if (key === 'updated') return it.modified ? new Date(it.modified).getTime() : 0
      return (it.name || '').toLowerCase()
    }
    if (key === 'name') return (it.name || '').toLowerCase()
    if (key === 'distance') return it.distanceNm ?? Number.POSITIVE_INFINITY
    if (key === 'bearing') return it.bearing ?? Number.POSITIVE_INFINITY
    if (key === 'updated') return it.updated ? new Date(it.updated).getTime() : 0
    return it.name
  }
  // Return sorted shallow copy.
  return [...list].sort((a, b) => (getv(a) < getv(b) ? -1 : getv(a) > getv(b) ? 1 : 0) * dir)
}

// Slice list according to pagination settings.
function paginate(list, page, size) {
  const totalPages = Math.max(1, Math.ceil(list.length / size))
  const current = Math.min(Math.max(page, 1), totalPages)
  const start = (current - 1) * size
  return { page: current, totalPages, items: list.slice(start, start + size) }
}

// Calculate a dynamic page size from the visible table height.
function computePageSize(tab) {
  const wrap = $('#tableWrap')
  if (!wrap) return state.pageSize[tab] || 8
  const head = wrap.querySelector('thead')
  const headerH = head ? head.offsetHeight : 0
  const available = Math.max(0, wrap.clientHeight - headerH - 12)
  const rowH = 52
  const calc = Math.max(1, Math.floor(available / rowH))
  return calc || state.pageSize[tab] || 8
}

// Find icon metadata by id.
function getIconMeta(iconId) {
  if (!iconId) return null
  for (const catalog of iconCatalogs()) {
    const match = findIconInCatalog(catalog, iconId)
    if (match) return match
  }
  return null
}

// Render an icon cell using loaded manifest.
function renderIconCell(iconId, { fallbackId = 'waypoint' } = {}) {
  // Wrapper span for icon image.
  const wrap = document.createElement('span')
  // Assign styling class.
  wrap.className = 'imgicon'
  const resolvedId = iconId || fallbackId
  // Find matching icon metadata.
  const ic = getIconMeta(resolvedId)
  // Fallback text when icon missing.
  if (!ic) { wrap.textContent = '—'; wrap.classList.add('muted'); return wrap }
  // Build image element.
  const img = document.createElement('img')
  const base = ic.baseUrl || state.icons?.baseUrl || ''
  img.src = base + ic.path
  img.alt = ic.label || resolvedId
  img.style.filter = 'invert(1)'
  wrap.appendChild(img)
  return wrap
}

// Render icon plus readable label for detail view.
function renderIconDisplay(iconId) {
  const wrap = document.createElement('div')
  wrap.className = 'icon-display'
  const ic = getIconMeta(iconId)
  const fallback = ic ? ic : getIconMeta('waypoint')
  wrap.appendChild(renderIconCell(iconId, { fallbackId: fallback?.id || 'waypoint' }))
  const label = document.createElement('span')
  label.className = 'icon-display__label'
  label.textContent = ic?.label || iconId || fallback?.label || '—'
  wrap.appendChild(label)
  return wrap
}

// Helper to create a small icon-only button for row actions.
function btnTiny(iconId, label, onClick) {
  // Build button element.
  const b = document.createElement('button')
  // Apply styling classes.
  b.className = 'btn btn--tiny'
  // Button type for forms.
  b.type = 'button'
  // Embed icon span.
  b.innerHTML = `<span class="icon" data-icon="${iconId}"></span>`
  // Attach click handler.
  b.addEventListener('click', onClick)
  // Locate icon metadata for mask application.
  const ic = getIconMeta(iconId)
  if (ic) {
    const url = (ic.baseUrl || state.icons?.baseUrl || '') + ic.path
    const el = b.querySelector('.icon')
    el.style.webkitMaskImage = `url(${url})`
    el.style.maskImage = `url(${url})`
  }
  return b
}

function applyIconMask(el, iconId) {
  const ic = getIconMeta(iconId)
  if (!ic) return
  const url = (ic.baseUrl || state.icons?.baseUrl || '') + ic.path
  const iconEl = el.querySelector('.icon')
  if (!iconEl) return
  iconEl.style.webkitMaskImage = `url(${url})`
  iconEl.style.maskImage = `url(${url})`
}

// Render action buttons for a given item.
function renderActions(it) {
  // Container for inline row actions.
  const wrap = document.createElement('div')
  wrap.className = 'row-actions'
  if (it.type === 'waypoints') {
    const notes = state.notesByWaypoint.get(it.id) || []
    if (notes.length) wrap.appendChild(btnTiny('file', 'Notes', () => openNoteView(it.id)))
    wrap.appendChild(btnTiny('goto', 'Go to', () => gotoWaypoint(it)))
    wrap.appendChild(btnTiny('map', 'Show on map', () => showOnMap(it)))
  } else if (it.type === 'files') {
    wrap.appendChild(btnTiny('download', 'Download', (ev) => {
      ev.stopPropagation()
      remoteDownload(it.id)
    }))
    wrap.appendChild(btnTiny('edit', 'View', () => openDetail(it)))
    wrap.appendChild(btnTiny('trash', 'Delete', () => deleteResource(it)))
  } else {
    wrap.appendChild(btnTiny('trash', 'Delete', () => deleteResource(it)))
  }
  return wrap
}

// Escape HTML to prevent injection in text fields rendered with innerHTML.
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]))
}

// Clear detail panel and TinyMCE instances.
function closeDetail() {
  const panel = $('#detailPanel')
  if (panel) panel.classList.add('hidden')

  // Pedagogical note:
  // TinyMCE creates iframes and global event handlers; if we do not remove editors
  // when closing the panel, memory leaks and duplicate toolbars can appear.
  removeAllTinies()

  // Reset detail state.
  state.detail = { item: null, preview: null, edit: false, isNew: false }
}

function closeNoteView() {
  const panel = $('#notePanel')
  if (panel) panel.classList.add('hidden')
  state.noteView = { waypointId: null, notes: [], index: 0 }
}

// Render a property row for the detail table.
function propRow(label, valueNode) {
  const tr = document.createElement('tr')
  const th = document.createElement('th')
  th.textContent = label
  const td = document.createElement('td')
  td.appendChild(valueNode)
  tr.appendChild(th); tr.appendChild(td)
  return tr
}

// Build a select element for icons.
function buildSelectFromCatalog(catalog, selected = '', blankLabel = '— choose —') {
  const sel = document.createElement('select')
  const blank = document.createElement('option')
  blank.value = ''
  blank.textContent = blankLabel
  sel.appendChild(blank)
  for (const ic of catalog?.icons || []) {
    const o = document.createElement('option')
    o.value = ic.id
    o.textContent = ic.label
    if (ic.id === selected) o.selected = true
    sel.appendChild(o)
  }
  return sel
}

function buildTypeSelect(selected = '') {
  return buildSelectFromCatalog(state.waypointsTypes, selected, '— choose —')
}

function buildSkIconSelect(selected = '') {
  return buildSelectFromCatalog(state.skIcons, selected, '— none —')
}

// Render a tree view for nested property objects.
function renderTreeView(obj) {
  const host = document.createElement('div')
  host.className = 'treeview'

  const header = document.createElement('div')
  header.className = 'treeview__row treeview__header'
  header.innerHTML = '<div>Key</div><div>Type</div><div>Value</div>'
  host.appendChild(header)

  const root = document.createElement('div')
  root.className = 'treeview__root'
  host.appendChild(root)

  const renderValuePreview = (value) => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return `Array(${value.length})`
    if (typeof value === 'object') return 'Object'
    if (typeof value === 'string') return `"${value}"`
    return String(value)
  }

  const renderTypeLabel = (value) => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
  }

  const renderRow = (key, value) => {
    const row = document.createElement('div')
    row.className = 'treeview__row'
    const keyNode = document.createElement('div')
    keyNode.className = 'treeview__key'
    keyNode.textContent = key
    const typeNode = document.createElement('div')
    typeNode.className = 'treeview__type'
    typeNode.textContent = renderTypeLabel(value)
    const valueNode = document.createElement('div')
    valueNode.className = 'treeview__value'
    valueNode.textContent = renderValuePreview(value)
    row.appendChild(keyNode)
    row.appendChild(typeNode)
    row.appendChild(valueNode)
    return row
  }

  const renderNode = (key, value) => {
    if (value && typeof value === 'object') {
      const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value)
      const details = document.createElement('details')
      details.className = 'treeview__node'
      const summary = document.createElement('summary')
      summary.appendChild(renderRow(key, value))
      details.appendChild(summary)
      const children = document.createElement('div')
      children.className = 'treeview__children'
      if (!entries.length) {
        const emptyRow = document.createElement('div')
        emptyRow.className = 'treeview__row treeview__empty'
        emptyRow.innerHTML = '<div>(empty)</div><div>—</div><div>—</div>'
        children.appendChild(emptyRow)
      } else {
        for (const [childKey, childValue] of entries) {
          children.appendChild(renderNode(childKey, childValue))
        }
      }
      details.appendChild(children)
      return details
    }
    return renderRow(key, value)
  }

  const entries = obj && typeof obj === 'object' ? Object.entries(obj) : []
  if (!entries.length) {
    const emptyRow = document.createElement('div')
    emptyRow.className = 'treeview__row treeview__empty'
    emptyRow.innerHTML = '<div>(empty)</div><div>—</div><div>—</div>'
    root.appendChild(emptyRow)
  } else {
    for (const [key, value] of entries) {
      root.appendChild(renderNode(key, value))
    }
  }

  return host
}

function getPropByPath(obj, path) {
  if (!obj || !path) return undefined
  const parts = path.split('.').filter(Boolean)
  let cur = obj
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function deletePropByPath(obj, path) {
  if (!obj || !path) return
  const parts = path.split('.').filter(Boolean)
  if (!parts.length) return
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (!cur[key] || typeof cur[key] !== 'object') return
    cur = cur[key]
  }
  delete cur[parts[parts.length - 1]]
}

function iconIdFromValue(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    return value.icon || value.skIcon || value.id || value.type || ''
  }
  return String(value)
}

function labelFromValue(value) {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return fmt(value, 2)
  if (typeof value === 'object') return value.label || value.name || value.title || value.id || JSON.stringify(value)
  return String(value)
}

function renderIconText(iconId, labelText) {
  console.log("iconId:",iconId)
  console.log("labelText:",labelText)
  const wrap = document.createElement('div')
  wrap.className = 'icon-display'
  wrap.appendChild(renderIconCell(iconId, { fallbackId: 'waypoint' }))
  const label = document.createElement('span')
  label.className = 'icon-display__label'
  label.textContent = labelText || getIconMeta(iconId)?.label || iconId || '—'
  wrap.appendChild(label)
  return wrap
}

// Helper: create a text node with a safe fallback.
function txt(s) {
  return document.createTextNode(s == null || s === '' ? '—' : String(s))
}

// Helper: render either a single value or an array with a renderer.
// Uses DocumentFragment to minimize layout work.
function renderOneOrMany(value, renderFn, { wrapTag = 'div', wrapClass = '' } = {}) {
  if (!Array.isArray(value)) return renderFn(value)

  const wrap = document.createElement(wrapTag)
  if (wrapClass) wrap.className = wrapClass

  const frag = document.createDocumentFragment()
  for (let i = 0; i < value.length; i++) {
    frag.appendChild(renderFn(value[i]))
  }
  wrap.appendChild(frag)
  return wrap
}

function renderCustomValue(value, mode = 'single-line') {
  // Keep original semantics: null/undefined shows em dash.
  if (value == null) return txt('—')

  switch (mode) {
    case 'tree':
      // Original behavior: only render tree when it's an object-like value.
      return (typeof value === 'object') ? renderTreeView(value) : txt(labelFromValue(value))

    case 'icon':
      return renderOneOrMany(
          value,
          (v) => renderIconCell(v, { fallbackId: 'waypoint' }),
          { wrapClass: 'icon-list' } // optional styling hook
      )

    case 'icon-text':
      return renderOneOrMany(
          value,
          (v) => renderIconDisplay(v),
          { wrapClass: 'icon-text-list' } // optional styling hook
      )

    case 'number':
      // Preserve numeric formatting behavior.
      if (typeof value === 'number' && Number.isFinite(value)) return txt(fmt(value, 2))
      return txt(labelFromValue(value))

    case 'array':
      // Delegate to existing renderer (keeps your UI formatting).
      return renderListItems(value)

    case 'text':
      return txt(labelFromValue(value))

    default:
      // Fallback behavior identical to original:
      // - arrays → join
      // - objects → JSON
      // - primitives → String
      if (Array.isArray(value)) return txt(value.join(', '))
      if (typeof value === 'object') return txt(JSON.stringify(value))
      return txt(value)
  }
}

function labelFromPath(path) {
  if (!path) return '—'
  const parts = path.split('.').filter(Boolean)
  return parts[parts.length - 1] || path
}

function sharedPathPrefix(paths) {
  if (!paths?.length) return ''
  const segments = paths.map(path => path.split('.'))
  const shortest = Math.min(...segments.map(parts => parts.length))
  const prefix = []
  for (let i = 0; i < shortest; i++) {
    const part = segments[0][i]
    if (segments.every(parts => parts[i] === part)) prefix.push(part)
    else break
  }
  return prefix.join('.')
}

function normalizeWaypointPropertyView(view) {
  if (!view || typeof view !== 'object') return null
  if (Array.isArray(view.properties)) {
    const items = view.properties
        .map(prop => ({
          path: prop?.property || prop?.path || '',
          label: prop?.label || '',
          mode: prop?.mode || 'single-line'
        }))
        .filter(item => item.path)
    return {
      label: view.label || '',
      layout: view.layout || null,
      items
    }
  }
  const paths = Array.isArray(view?.paths) ? view.paths.filter(Boolean) : (view?.path ? [view.path] : [])
  const items = paths.map((path, index) => ({
    path,
    label: Array.isArray(view?.labels) ? view.labels[index] : '',
    mode: view?.mode || 'single-line'
  }))
  if (!items.length) return null
  return {
    label: view.label || '',
    layout: view.mode === 'three-view' ? 'three-view' : null,
    items
  }
}

function renderGroupedValues(values, { layout } = {}) {
  const wrap = document.createElement('div')
  const isThree = layout === 'three-view'
  wrap.className = `prop-group${isThree ? ' prop-group--three' : ''}`
  values.forEach(({ value, label, path, mode }) => {
    const item = document.createElement('div')
    item.className = 'prop-group__item'
    const labelNode = document.createElement('div')
    labelNode.className = 'prop-group__label muted'
    labelNode.textContent = label || labelFromPath(path) || '—'
    const valueNode = renderCustomValue(value, isThree ? 'text' : (mode || 'text'))
    item.appendChild(labelNode)
    item.appendChild(valueNode)
    wrap.appendChild(item)
  })
  return wrap
}

function renderListItems(items) {
  const wrap = document.createElement('div')
  wrap.className = 'detail-list'
  if (!items || (Array.isArray(items) && !items.length)) {
    wrap.textContent = '—'
    wrap.classList.add('muted')
    return wrap
  }
  const list = Array.isArray(items) ? items : [items]
  for (const item of list) {
    const row = document.createElement('div')
    row.className = 'detail-list__row'
    if (item && typeof item === 'object') {
      const parts = []
      if (item.name) parts.push(item.name)
      if (item.type) parts.push(item.type)
      if (item.phone) parts.push(item.phone)
      if (item.email) parts.push(item.email)
      if (item.href) parts.push(item.href)
      row.textContent = parts.length ? parts.join(' • ') : JSON.stringify(item)
    } else {
      row.textContent = String(item)
    }
    wrap.appendChild(row)
  }
  return wrap
}

function noteListFromResponse(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (typeof data === 'object') {
    return Object.entries(data).map(([id, note]) => ({ id, ...(note || {}) }))
  }
  return []
}

function noteMime(note) {
  const mime = (note?.mimeType || note?.mime || note?.contentType || '').trim()
  return mime || 'text/plain'
}

function noteTitle(note, fallback = 'Note') {
  return note?.title || note?.name || note?.subject || note?.id || fallback
}

function noteText(note) {
  if (!note) return ''
  if (typeof note.text === 'string') return note.text
  if (typeof note.content === 'string') return note.content
  if (typeof note.description === 'string') return note.description
  if (typeof note.body === 'string') return note.body
  if (note.content && typeof note.content.text === 'string') return note.content.text
  return ''
}

function normalizeFilePath(pathValue) {
  return (pathValue || '').replace(/\\/g, '/')
}

function matchFileRoot(filePath) {
  const normalized = normalizeFilePath(filePath)
  const roots = state.config.fileRoots || []
  let match = null
  for (const root of roots) {
    if (!root.path) continue
    const rootPath = normalizeFilePath(root.path).replace(/\/+$/,'')
    if (normalized.startsWith(rootPath)) {
      if (!match || rootPath.length > match.rootPath.length) {
        match = { root, rootPath }
      }
    }
  }
  if (!match) return null
  const rel = normalized.slice(match.rootPath.length).replace(/^\/+/, '')
  return { root: match.root, relPath: rel }
}

async function fetchWaypointNotes(waypointId) {
  if (!waypointId) return []
  if (state.notesByWaypoint.has(waypointId)) return state.notesByWaypoint.get(waypointId)
  const href = encodeURIComponent(`"/resources/waypoints/${waypointId}"`)
  const res = await fetch(`/signalk/v2/api/resources/notes/?href=${href}`, { cache: 'no-cache' })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `Notes failed: ${res.status}`)
  const notes = noteListFromResponse(j)
  state.notesByWaypoint.set(waypointId, notes)
  return notes
}

async function openNoteView(waypointId) {
  const notes = state.notesByWaypoint.get(waypointId) || []
  state.noteView = { waypointId, notes, index: 0 }
  await renderNoteView()
}

async function renderNoteView() {
  const panel = $('#notePanel')
  if (!panel) return
  const { waypointId, notes, index } = state.noteView
  if (!waypointId || !notes.length) { panel.classList.add('hidden'); return }
  panel.classList.remove('hidden')
  const title = $('#noteTitle')
  const meta = $('#noteMeta')
  const actions = $('#noteActions')
  const body = $('#noteBody')
  actions.innerHTML = ''
  body.innerHTML = ''
  const note = notes[index] || notes[0]
  const mime = noteMime(note)
  const noteName = noteTitle(note, `Note ${index + 1}`)
  title.textContent = noteName
  meta.textContent = `Note ${index + 1} of ${notes.length}`

  if (notes.length > 1) {
    const select = document.createElement('select')
    select.className = 'note__select'
    notes.forEach((n, i) => {
      const opt = document.createElement('option')
      opt.value = i
      opt.textContent = noteTitle(n, `Note ${i + 1}`)
      if (i === index) opt.selected = true
      select.appendChild(opt)
    })
    select.addEventListener('change', async (e) => {
      state.noteView.index = Number(e.target.value)
      await renderNoteView()
    })
    actions.appendChild(select)
  }

  const toolbar = document.createElement('div')
  toolbar.className = 'note__toolbar'
  const url = note?.url || note?.link || ''
  if (url) {
    if (url.startsWith('file://')) {
      const btn = document.createElement('button')
      btn.className = 'btn btn--tiny'
      btn.innerHTML = '<span class="icon" data-icon="file"></span> Open file'
      applyIconMask(btn, 'file')
      btn.addEventListener('click', async () => {
        const filePath = decodeURIComponent(url.replace('file://', ''))
        const match = matchFileRoot(filePath)
        body.innerHTML = ''
        if (!match) {
          const p = document.createElement('p')
          p.className = 'note__empty'
          p.textContent = 'File is outside configured roots.'
          body.appendChild(p)
          return
        }
        const preview = await remotePreview(match.relPath, match.root.id)
        if (preview?.error) {
          const p = document.createElement('p')
          p.className = 'note__empty'
          p.textContent = preview.error
          body.appendChild(p)
          return
        }
        if (preview?.kind === 'text') {
          const pre = document.createElement('pre')
          pre.className = 'note__content'
          pre.textContent = preview.text || ''
          body.appendChild(pre)
          return
        }
        if (preview?.kind === 'binary') {
          body.appendChild(previewBinary(preview.mime, preview.data))
          return
        }
        const p = document.createElement('p')
        p.className = 'note__empty'
        p.textContent = 'Unable to preview file.'
        body.appendChild(p)
      })
      toolbar.appendChild(btn)
    } else {
      const btn = document.createElement('button')
      btn.className = 'btn btn--tiny'
      btn.innerHTML = '<span class="icon" data-icon="arrow-right"></span> Open link'
      applyIconMask(btn, 'arrow-right')
      btn.addEventListener('click', () => window.open(url, '_blank'))
      toolbar.appendChild(btn)
    }
  }
  if (note?.position?.latitude != null && note?.position?.longitude != null) {
    const btn = document.createElement('button')
    btn.className = 'btn btn--tiny'
    btn.innerHTML = '<span class="icon" data-icon="map"></span> Map'
    applyIconMask(btn, 'map')
    btn.addEventListener('click', () => showOnMap({ id: waypointId, name: noteName, position: note.position }))
    toolbar.appendChild(btn)
  }
  if (toolbar.childNodes.length) actions.appendChild(toolbar)

  if (mime.startsWith('text/')) {
    const text = noteText(note)
    const pre = document.createElement('pre')
    pre.className = 'note__content'
    pre.textContent = text || '—'
    body.appendChild(pre)
  } else {
    const text = noteText(note)
    if (text) {
      const pre = document.createElement('pre')
      pre.className = 'note__content'
      pre.textContent = text
      body.appendChild(pre)
    } else {
      const p = document.createElement('p')
      p.className = 'note__empty'
      p.textContent = `No preview available for ${mime}.`
      body.appendChild(p)
    }
  }
}

// Render the waypoint detail view (optimized).
function renderWaypointDetail(it, editMode, { allowPropertyEdit = false } = {}) {
  const table = document.createElement('table')
  table.className = 'proptable'

  // Cache raw waypoint once.
  const raw = state.resources.waypoints?.[it.id] || it.raw || {}

  // Cache feature/properties references once (avoid repeated optional chains).
  const feature = raw.feature || null
  const rawProps = (feature && feature.properties) ? feature.properties : (raw.properties || {})
  const p = rawProps || {}

  // Build DOM offscreen, then append once.
  const frag = document.createDocumentFragment()

  // --- Helpers for this function (small, fast, avoids repeated code) ---
  const mkInput = (id, value) => {
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.id = id
    inp.value = value || ''
    return inp
  }

  const mkTextarea = (id, value, rows = 6) => {
    const ta = document.createElement('textarea')
    ta.id = id
    ta.className = 'editor__text'
    ta.rows = rows
    ta.value = value || ''
    return ta
  }

  const mkNumber = (id, placeholder, value) => {
    const inp = document.createElement('input')
    inp.type = 'number'
    inp.step = '0.000001'
    inp.id = id
    inp.placeholder = placeholder
    inp.value = (value ?? '') // preserve empty string when nullish
    return inp
  }

  const mkLabelValue = (label, valueText) => {
    const wrap = document.createElement('div')
    const lab = document.createElement('div')
    lab.className = 'muted'
    lab.textContent = label
    const val = document.createElement('div')
    val.textContent = valueText
    wrap.appendChild(lab)
    wrap.appendChild(val)
    return wrap
  }

  // --- Name ---
  const nameValue = raw.name || it.name || ''
  const nameField = editMode
      ? (() => {
        const inp = mkInput('detailEditName', nameValue)
        return inp
      })()
      : document.createTextNode(nameValue)

  frag.appendChild(propRow('Name', nameField))

  // --- Description ---
  const descValue = raw.description || it.description || ''
  const descField = editMode
      ? mkTextarea('detailWpDescEditor', descValue, 6) // TinyMCE mounted elsewhere in edit mode
      : document.createTextNode(descValue)

  frag.appendChild(propRow('Description', descField))

  // --- Coordinates ---
  const pos = raw.position || it.position || null
  const latVal = pos?.latitude ?? null
  const lonVal = pos?.longitude ?? null

  const coordsField = editMode
      ? (() => {
        const wrap = document.createElement('div')
        wrap.className = 'coords-row'
        wrap.appendChild(mkNumber('detailEditLat', 'Latitude', latVal))
        wrap.appendChild(mkNumber('detailEditLon', 'Longitude', lonVal))
        return wrap
      })()
      : (() => {
        const wrap = document.createElement('div')
        wrap.className = 'coords-row'
        const formatted = (latVal == null || lonVal == null)
            ? { lat: '—', lon: '—' }
            : formatLatLon(latVal, lonVal)
        wrap.appendChild(mkLabelValue('Lat', formatted.lat))
        wrap.appendChild(mkLabelValue('Lon', formatted.lon))
        return wrap
      })()

  frag.appendChild(propRow('Position', coordsField))

  // --- Distance / Bearing (view mode only) ---
  if (!editMode) {
    const metrics = document.createElement('div')
    metrics.className = 'detail-metrics'

    const distWrap = document.createElement('div')
    distWrap.className = 'detail-metric'
    distWrap.appendChild(mkLabelValue(`Distance (${distanceUnitLabel(state.config.distanceUnit)})`, '')) // label node
    const distNode = distWrap.lastChild.lastChild
    distNode.id = 'detailDistance'
    distNode.textContent = formatDistance(it.distanceNm)

    const brgWrap = document.createElement('div')
    brgWrap.className = 'detail-metric'
    brgWrap.appendChild(mkLabelValue('Bearing (°)', ''))
    const brgNode = brgWrap.lastChild.lastChild
    brgNode.id = 'detailBearing'
    brgNode.textContent = formatBearing(it.bearing)

    metrics.appendChild(distWrap)
    metrics.appendChild(brgWrap)

    frag.appendChild(propRow('Distance / Bearing', metrics))
  }

  // --- Type + Icon override ---
  const typeVal = p.type || raw.type || it.wpType || 'waypoint'
  const skIconVal = p.skIcon || it.skIcon || ''
  const iconId = it.icon || p.icon || ''

  const typeField = editMode
      ? (() => {
        const sel = buildTypeSelect(typeVal)
        sel.id = 'detailEditType'
        return sel
      })()
      : document.createTextNode(typeVal || '—')

  frag.appendChild(propRow('Type', typeField))

  if (editMode) {
    const iconOverrideField = (() => {
      const sel = buildSkIconSelect(skIconVal)
      sel.id = 'detailEditIconOverride'
      return sel
    })()
    frag.appendChild(propRow('Icon override', iconOverrideField))
  }

  // --- Properties editor (admin edit mode only) ---
  if (editMode && allowPropertyEdit) {
    // Keep JSON as text; TinyMCE mounted in edit mode only.
    const propsText = JSON.stringify(p || {}, null, 2)
    const ta = mkTextarea('detailWpPropsEditor', propsText, 12)
    frag.appendChild(propRow('Properties', ta))
  }

  if (!editMode) {
    // --- Property views + tree rendering ---
    // Only prepare the "remaining properties" tree copy if we will render the tree.
    const willRenderTree = (!editMode || !allowPropertyEdit)
    const propertiesForTree = willRenderTree ? structuredCloneSafe(p || {}) : null

    // Render configured views (summary rows).
    const views = state.config.waypointPropertyViews || []
    for (let vi = 0; vi < views.length; vi++) {
      const normalized = normalizeWaypointPropertyView(views[vi])
      if (!normalized) continue

      const items = normalized.items
      if (!items || items.length === 0) continue

      const values = []
      let hasValues = false
      const paths = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const path = item.path
        paths.push(path)

        const value = getPropByPath(p, path)
        if (value !== undefined) hasValues = true

        values.push({
          path,
          label: item.label,
          mode: item.mode,
          value
        })
      }

      if (!hasValues) continue

      // Remove from tree copy only if we're actually going to show the tree.
      if (propertiesForTree) {
        for (let i = 0; i < values.length; i++) {
          deletePropByPath(propertiesForTree, values[i].path)
        }
      }

      const prefixLabel = paths.length ? sharedPathPrefix(paths) : ''
      const rowLabel =
          normalized.label ||
          prefixLabel ||
          (items.length === 1 ? items[0].path : 'Properties')

      if (items.length === 1 && normalized.layout !== 'three-view') {
        const mode = values[0].mode || 'single-line'
        frag.appendChild(propRow(rowLabel, renderCustomValue(values[0].value, mode)))
      } else {
        frag.appendChild(propRow(rowLabel, renderGroupedValues(values, {layout: normalized.layout})))
      }
    }

    // Tree view of remaining props (view mode OR non-admin edit mode).
    if (willRenderTree) {
      frag.appendChild(propRow('Properties', renderTreeView(propertiesForTree)))
    }
  }

  // One append to the table.
  table.appendChild(frag)
  return table
}

// Safe clone helper: uses structuredClone when available, falls back to JSON copy.
function structuredCloneSafe(v) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(v)
  } catch {}
  // Fallback (matches your previous JSON copy semantics).
  return JSON.parse(JSON.stringify(v))
}

// Render the route detail view (read-only summary).
function renderRouteDetail(it) {
  const table = document.createElement('table')
  table.className = 'proptable'
  table.appendChild(propRow('Name', document.createTextNode(it.name || it.id)))
  table.appendChild(propRow('Description', document.createTextNode(it.description || '—')))
  table.appendChild(propRow('Updated', document.createTextNode(it.updated ? new Date(it.updated).toLocaleString() : '—')))
  return table
}

// Render the file detail view, including previews/editors.
async function renderFileDetail(it, preview, editMode, isNew, { fullView = false } = {}) {
  const frag = document.createDocumentFragment()
  if (!fullView) {
    const table = document.createElement('table')
    table.className = 'proptable'
    table.appendChild(propRow('Path', document.createTextNode(it.id)))
    table.appendChild(propRow('Type', document.createTextNode(it.fileType)))
    if (preview?.mime) table.appendChild(propRow('MIME', document.createTextNode(preview.mime)))
    if (it.fileType === 'file' && it.size != null) table.appendChild(propRow('Size', document.createTextNode(humanSize(it.size))))
    if (it.modified) table.appendChild(propRow('Modified', document.createTextNode(new Date(it.modified).toLocaleString())))
    frag.appendChild(table)
  }

  if (preview?.error) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = preview.error
    frag.appendChild(p)
    return { node: frag, saveable: false }
  }

  if (it.fileType === 'dir') {
    const p = document.createElement('p')
    p.textContent = 'Open the directory from the list to browse entries.'
    frag.appendChild(p)
    return { node: frag, saveable: false }
  }

  if (isTextPreview(preview, editMode, isNew)) {
    const pathField = document.createElement('input')
    pathField.type = 'text'
    pathField.id = 'detailFilePath'
    pathField.value = it.id
    pathField.className = 'textfield'
    const saveTable = document.createElement('table')
    saveTable.className = `proptable${fullView ? ' proptable--compact' : ''}`
    saveTable.appendChild(propRow('Save as', pathField))
    frag.appendChild(saveTable)
    const host = document.createElement('div')
    host.className = 'editorhost'
    const ta = document.createElement('textarea')
    ta.id = 'detailTextEditor'
    ta.className = 'editor__text'
    host.appendChild(ta)
    frag.appendChild(host)
    await setTextEditorValue(preview?.text || '', '#detailTextEditor')
    return { node: frag, saveable: true }
  }

  if (isBinaryPreview(preview)) {
    frag.appendChild(previewBinary(preview.mime, preview.data))
    return { node: frag, saveable: false }
  }

  const fallback = document.createElement('p')
  fallback.textContent = 'Binary file — download to edit.'
  frag.appendChild(fallback)
  return { node: frag, saveable: false }
}

// Render the detail overlay with content specific to the selected item.
async function renderDetail() {
  const panel = $('#detailPanel')
  if (!panel) return
  const saveBtn = $('#btnSaveDetail')
  if (!state.detail.item) { panel.classList.add('hidden'); return }
  panel.classList.remove('hidden')
  panel.classList.add('detail--open')
  const { item, preview, edit, isNew } = state.detail
  const titleEl = $('#detailTitle')
  titleEl.innerHTML = ''
  if (item.type === 'waypoints') {
    const row = document.createElement('div')
    row.className = 'detail__title-row'
    const iconWrap = document.createElement('span')
    iconWrap.className = 'detail__title-icon'
    iconWrap.appendChild(renderIconCell(item.icon, { fallbackId: 'waypoint' }))
    const text = document.createElement('span')
    text.textContent = item.name || item.id
    row.appendChild(iconWrap)
    row.appendChild(text)
    titleEl.appendChild(row)
  } else {
    titleEl.textContent = `${item.type.slice(0, -1).toUpperCase()}: ${item.name}`
  }
  const metaNode = $('#detailMeta')
  if (item.type === 'files') metaNode.textContent = buildFileMeta(item, preview)
  else metaNode.textContent = ''
  const actions = $('#detailActions')
  const body = $('#detailBody')
  actions.innerHTML = ''
  body.innerHTML = ''
  let saveable = false
  saveBtn.classList.add('hidden')
  body.classList.remove('detail__body--full')

  if (item.type === 'waypoints') {
    if (edit) await fetchLoginStatus({ silent: true })
    const notes = state.notesByWaypoint.get(item.id) || []
    if (notes.length) {
      actions.appendChild(btnTiny('file', 'Notes', async () => openNoteView(item.id)))
    }
    actions.appendChild(btnTiny('goto', 'Go to', () => gotoWaypoint(item)))
    actions.appendChild(btnTiny('map', 'Show on map', () => showOnMap(item)))
    const toggleEdit = btnTiny(edit ? 'close' : 'edit', 'Edit', async () => { state.detail.edit = !state.detail.edit; await renderDetail() })
    actions.appendChild(toggleEdit)
    actions.appendChild(btnTiny('trash', 'Delete', () => deleteResource(item)))
    const allowPropertyEdit = edit && state.auth.userLevel === 'admin'
    body.appendChild(renderWaypointDetail(item, edit, { allowPropertyEdit }))

    // If we are editing, mount TinyMCE on the Description (and Properties for admin).
    // Pedagogical note:
    // - We set content *after* the DOM nodes exist, because TinyMCE needs the textarea in the document.
    if (edit) {
      const rawWp = state.resources.waypoints?.[item.id] || item.raw || {}
      await setTextEditorValue(rawWp.description || '', '#detailWpDescEditor')
      if (allowPropertyEdit) {
        const props = rawWp.feature?.properties || rawWp.properties || {}
        await setTextEditorValue(JSON.stringify(props || {}, null, 2), '#detailWpPropsEditor')
      }
    }

    saveable = edit
  } else if (item.type === 'routes') {
    actions.appendChild(btnTiny('trash', 'Delete', () => deleteResource(item)))
    body.appendChild(renderRouteDetail(item))
  } else if (item.type === 'files') {
    actions.appendChild(btnTiny('download', 'Download', () => remoteDownload(item.id)))
    if (item.fileType === 'file') {
      actions.appendChild(btnTiny('edit', 'Rename', async () => {
        const base = item.id.split('/').pop()
        const next = prompt('New name:', base)
        if (next) {
          const ok = await remoteRename(item.id, next)
          if (ok) {
            await remoteList(filesState.remotePath)
            await openDetail({ ...item, id: buildRelPath(next), name: next, fileType: 'file' })
          }
        }
      }))
      actions.appendChild(btnTiny('arrow-right', 'Move', async () => {
        const dest = await remoteMove(item.id)
        if (dest) await openDetail({ ...item, id: dest, name: dest.split('/').pop(), fileType: 'file' })
      }))
    }
    actions.appendChild(btnTiny('trash', 'Delete', () => deleteResource(item)))
    const fullView = isTextPreview(preview, edit, isNew) || isBinaryPreview(preview)
    if (fullView) body.classList.add('detail__body--full')
    const fileDetail = await renderFileDetail(item, preview, edit, isNew, { fullView })
    saveable = fileDetail.saveable
    body.appendChild(fileDetail.node)
  }

  if (saveable) saveBtn.classList.remove('hidden')
}

// Open the detail overlay for a given item.
async function openDetail(it, opts = {}) {
  // Ensure we start from a clean editor slate.
  // This avoids TinyMCE instances from previous items (files/waypoints) lingering in the DOM.
  removeAllTinies()
  state.detail = { item: it, preview: null, edit: !!opts.edit, isNew: !!opts.isNew }
  try {
    if (opts.preview) {
      state.detail.preview = opts.preview
    } else if (it.type === 'files') {
      filesState.selectedRemote = it.id
      if (opts.isNew) {
        state.detail.preview = { kind: 'text', text: '' }
        state.detail.edit = true
      } else if (it.fileType === 'file') {
        state.detail.preview = await remotePreview(it.id)
        if (state.detail.preview?.kind === 'text') state.detail.edit = true
      } else {
        state.detail.preview = { kind: 'dir' }
      }
    } else if (it.type === 'waypoints') {
      computeDerived(it)
      state.detail.preview = { raw: state.resources.waypoints?.[it.id] || it.raw }
      fetchWaypointNotes(it.id)
          .then(() => { if (state.detail.item?.id === it.id) renderDetail() })
          .catch(() => {})
    } else if (it.type === 'routes') {
      state.detail.preview = { raw: state.resources.routes?.[it.id] || it.raw }
    }
  } catch (e) {
    state.detail.preview = { ok: false, error: e.message || String(e) }
  }
  await renderDetail()
}

// Persist edits performed in the detail overlay.
async function saveDetail() {
  // Ensure write access
  if (!await ensureWriteAccess()) return

  const { item } = state.detail
  if (!item) return
  if (item.type === 'waypoints') {

    const name = $('#detailEditName')?.value?.trim()
    const description = (getTextEditorValue('#detailWpDescEditor') || '').trim()
    const lat = parseFloat($('#detailEditLat')?.value)
    const lon = parseFloat($('#detailEditLon')?.value)
    const wpType = $('#detailEditType')?.value?.trim()
    const skIcon = $('#detailEditIconOverride')?.value?.trim()
    const propertiesField = document.querySelector('#detailWpPropsEditor')
    let properties = {}
    if (propertiesField) {
      try {
        properties = JSON.parse(getTextEditorValue('#detailWpPropsEditor') || '{}')
      } catch (e) {
        setStatus('Invalid JSON in properties', false)
        return
      }
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        setStatus('Properties must be a JSON object', false)
        return
      }
    }
    if (skIcon) { properties.skIcon = skIcon }
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) { setStatus('Missing name/position', false); return }

    const updated = buildWaypointPayload({
      id: item.id,
      name: name,
      description: description,
      type: wpType,
      position: { latitude: lat, longitude: lon },
      properties: properties
    })
    try {
      setStatus('Saving...')
      const res = await fetch(`${RES_ENDPOINT('waypoints')}/${encodeURIComponent(item.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      await refresh()
      state.detail.edit = false
      await openDetail(normalizeResource('waypoints', item.id, updated))
      setStatus('Saved ✔', true)
    } catch (e) { setStatus(e.message || String(e), false) }
    return
  }

  if (item.type === 'files') {
    const path = $('#detailFilePath')?.value?.trim() || item.id
    const ok = await remoteSaveText(path, getTextEditorValue('#detailTextEditor'))
    if (ok) {
      await remoteList(filesState.remotePath)
      await openDetail({ ...item, id: path, name: path.split('/').pop(), fileType: 'file' }, { edit: true })
    }
  }
}

// Render table header cells depending on the active tab.
function renderTableHead() {
  const headRow = $('#tableHeadRow')
  if (!headRow) return
  const isFiles = state.tab === 'files'
  headRow.innerHTML = ''
  if (isFiles) {
    headRow.innerHTML = `
      <th style="width:40px"><input type="checkbox" id="selectAllHeader" /></th>
      <th>Type</th>
      <th>Name</th>
      <th class="num" style="text-align:right">Size</th>
      <th class="num" style="text-align:right">Modified</th>
      <th>Actions</th>`
  } else {
    const distLabel = distanceUnitLabel(state.config.distanceUnit)
    headRow.innerHTML = `
      <th style="width:40px"><input type="checkbox" id="selectAllHeader" /></th>
      <th>Type</th>
      <th>Name</th>
      <th class="num" style="text-align:right">Dist (${distLabel})</th>
      <th class="num" style="text-align:right">Brg (°)</th>
      <th>Actions</th>`
  }
  headRow.querySelector('#selectAllHeader')?.addEventListener('change', (e) => setSelectAll(e.target.checked))
}

// Render the current tab contents into the DOM.
function render() {
  // Determine if files tab is active.
  const isFiles = state.tab === 'files' && hasFileRoots()
  // Update header text for active tab.
  $('#listTitle').textContent = state.tab[0].toUpperCase() + state.tab.slice(1)

  // Toggle action bars.
  $('#navActions')?.classList.toggle('hidden', isFiles)
  $('#fileActions')?.classList.toggle('hidden', !isFiles)

  // Toggle filter fields that are navigation-specific.
  const withinField = $('#filterWithinNm')?.closest('.field')
  const iconField = $('#filterType')?.closest('.field')
  const rootField = $('#fileRootField')
  if (withinField) setHidden(withinField, isFiles)
  if (iconField) setHidden(iconField, isFiles)
  if (rootField) setHidden(rootField, !isFiles || state.config.fileRoots.length < 2)

  const disableWaypointActions = state.tab !== 'waypoints'
  $('#btnCreateHere')?.setAttribute('aria-disabled', disableWaypointActions)
  if ($('#btnCreateHere')) $('#btnCreateHere').disabled = disableWaypointActions
  if ($('#btnImport')) $('#btnImport').disabled = disableWaypointActions
  if ($('#btnExport')) $('#btnExport').disabled = disableWaypointActions

  // Compute items and derived metrics for waypoints.
  let list = getItemsForTab().map(it => {
    if (state.tab === 'waypoints') computeDerived(it)
    return it
  })

  // Apply filters and sorting.
  list = applyFilters(list)
  list = applySort(list)
  state.list = list

  // Apply pagination using viewport-aware page size.
  const pageSize = computePageSize(state.tab)
  state.pageSize[state.tab] = pageSize
  const paged = paginate(list, state.page[state.tab], pageSize)
  state.page[state.tab] = paged.page
  const viewList = paged.items

  // Update pager controls.
  $('#pagerInfo').textContent = `${paged.page}/${paged.totalPages}`
  $('#btnPagePrev').disabled = paged.page <= 1
  $('#btnPageNext').disabled = paged.page >= paged.totalPages

  // Update summary meta text.
  const metaParts = []
  if (isFiles) metaParts.push(renderCrumbs())
  metaParts.push(`${list.length} item(s)`)
  metaParts.push(`selected: ${state.selected.size}`)
  $('#listMeta').textContent = metaParts.join(' • ')

  renderTableHead()

  // Locate tbody for table rows.
  const tbody = $('#tbody')
  // Clear table body before rerender.
  tbody.innerHTML = ''
  // Reset row map for incremental updates.
  state.rows.clear()
  // Build rows for each item.
  for (const it of viewList) {
    const tr = document.createElement('tr')

    tr.addEventListener('click', (ev) => {
      if (ev.target.closest('button') || ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.tagName === 'OPTION') return
      if (it.type === 'files' && it.fileType === 'dir') {
        remoteList(it.id)
        return
      }
      openDetail(it)
    })

    const tdSel = document.createElement('td')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = state.selected.has(`${it.type}:${it.id}`)
    cb.addEventListener('change', () => {
      const k = `${it.type}:${it.id}`
      if (cb.checked) state.selected.add(k)
      else state.selected.delete(k)
      render()
    })
    tdSel.appendChild(cb)
    tr.appendChild(tdSel)

    if (isFiles) {
      const tdType = document.createElement('td')
      tdType.textContent = it.fileType === 'dir' ? 'DIR' : 'FILE'
      tdType.className = 'muted small'
      tr.appendChild(tdType)

      const tdName = document.createElement('td')
      tdName.innerHTML = `<div><strong>${escapeHtml(it.name)}</strong></div><div class="muted small">${escapeHtml(it.description || '')}</div>`
      tr.appendChild(tdName)

      const tdSize = document.createElement('td')
      tdSize.className = 'num'
      tdSize.textContent = it.fileType === 'dir' ? '—' : humanSize(it.size)
      tr.appendChild(tdSize)

      const tdMod = document.createElement('td')
      tdMod.className = 'num'
      tdMod.textContent = it.modified ? new Date(it.modified).toLocaleString() : '—'
      tr.appendChild(tdMod)

      const tdAct = document.createElement('td')
      tdAct.appendChild(renderActions(it))
      tr.appendChild(tdAct)
    } else {
      const tdIcon = document.createElement('td')
      tdIcon.appendChild(renderIconCell(it.icon))
      tr.appendChild(tdIcon)

      const tdName = document.createElement('td')
      tdName.innerHTML = `<div><strong>${escapeHtml(it.name)}</strong></div>`
      tr.appendChild(tdName)

      const tdDist = document.createElement('td')
      tdDist.className = 'num'
      tdDist.textContent = formatDistance(it.distanceNm)
      tr.appendChild(tdDist)

      const tdBrg = document.createElement('td')
      tdBrg.className = 'num'
      tdBrg.textContent = formatBearing(it.bearing)
      tr.appendChild(tdBrg)

      const tdAct = document.createElement('td')
      tdAct.appendChild(renderActions(it))
      tr.appendChild(tdAct)

      // Cache references for incremental metric updates.
      state.rows.set(`${it.type}:${it.id}`, { row: tr, distCell: tdDist, brgCell: tdBrg })
    }

    // Append row into table.
    tbody.appendChild(tr)
  }
}

// Refresh both waypoints and routes from server and rerender.
async function refresh() {
  try {
    setStatus('Refreshing…')
    await Promise.all([fetchResources('waypoints'), fetchResources('routes')])
    render()
    setStatus('Ready', true)
  } catch (e) {
    setStatus(e.message || String(e), false)
  }
}

// Send goto command via plugin API.
async function gotoWaypoint(it) {
  // Ensure write access
  if (!await ensureWriteAccess()) return

  try {
    setStatus('Setting goto…')
    const res = await fetch(API_BASE+'/goto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waypoint: { id: it.id, name: it.name, position: it.position } })
    })
    if (!res.ok) throw new Error(`Goto failed: ${res.status}`)
    setStatus('Goto set ✔', true)
  } catch (e) { setStatus(e.message || String(e), false) }
}

// Publish waypoint selection for map display.
async function showOnMap(it) {
  try {
    setStatus('Setting show on map…')
    const res = await fetch(API_BASE+'/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waypoint: { id: it.id, name: it.name, position: it.position } })
    })
    if (!res.ok) throw new Error(`Goto failed: ${res.status}`)
    setStatus('Goto set ✔', true)
  } catch (e) { setStatus(e.message || String(e), false) }
}

// Populate and open the edit dialog for a waypoint.
async function editWaypoint(it) {
  const dlg = $('#dlgEdit')
  dlg.dataset.id = it.id
  $('#editName').value = it.name || ''
  $('#editDesc').value = it.description || ''
  $('#editLat').value = it.position?.latitude ?? ''
  $('#editLon').value = it.position?.longitude ?? ''
  $('#editType').value = it.wpType || ''
  $('#editIconOverride').value = it.skIcon || ''
  dlg.showModal()
}

// Persist waypoint changes back to the server.
async function saveWaypoint() {

  // Ensure write access
  if (!await ensureWriteAccess()) return

  const id = $('#dlgEdit').dataset.id
  const name = $('#editName').value.trim()
  const description = $('#editDesc').value.trim()
  const lat = parseFloat($('#editLat').value)
  const lon = parseFloat($('#editLon').value)
  const wpType = $('#editType').value.trim()
  const skIcon = $('#editIconOverride').value.trim()
  const wpProperties = (getTextEditorValue('#detailWpPropsEditor') || $('#detailEditProperties')?.value || '').trim()
  if (!id || !name || Number.isNaN(lat) || Number.isNaN(lon)) { setStatus('Missing name/position', false); return }
  let properties = {}
  if (wpProperties) {
    properties = JSON.parse(wpProperties)
  }
  if (skIcon) {
    properties.skIcon = skIcon
  }

  const updated = buildWaypointPayload({
    id: id,
    name: name,
    description: description,
    type: wpType,
    position: { latitude: lat, longitude: lon },
    properties: properties
  })

  try {
    setStatus('Saving...')
    const res = await fetch(`${RES_ENDPOINT('waypoints')}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    })
    if (!res.ok) throw new Error(`Save failed: ${res.status}`)
    await refresh()
    setStatus('Saved ✔', true)
  } catch (e) { setStatus(e.message || String(e), false) }
}

// Delete a single resource after confirmation.
async function deleteResource(it, { skipConfirm = false, skipAccessCheck = false } = {}) {
  // Ensure write access
  if (!skipAccessCheck && !await ensureWriteAccess()) return

  try {
    if (!skipConfirm && !confirm(`Delete ${it.type.slice(0,-1)} "${it.name}"?`)) return
    //
    setStatus('Deleting...')
    if (it.type === 'files') {
      const ok = await remoteDelete(it.id, false)
      if (ok) { closeDetail(); setStatus('Deleted ✔', true) }
      return
    }
    const res = await fetch(`${RES_ENDPOINT(it.type)}/${encodeURIComponent(it.id)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
    state.selected.delete(`${it.type}:${it.id}`)
    await refresh()
    setStatus('Deleted ✔', true)
  } catch (e) { setStatus(e.message || String(e), false) }
}

// Bulk delete currently selected items for the active tab.
async function bulkDelete() {

  // Ensure write access
  if (!await ensureWriteAccess()) return

  const keys = [...state.selected].filter(k => k.startsWith(state.tab + ':'))
  if (!keys.length) return
  if (!confirm(`Delete ${keys.length} selected ${state.tab}?`)) return

  const ctrl = beginProgress(`Deleting ${keys.length} item(s)…`, { indeterminate: false })
  try {
    if (state.tab === 'files') {
      const itemMap = new Map(getItemsForTab().map(it => [it.id, it]))
      for (let i = 0; i < keys.length; i++) {
        if (ctrl.signal.aborted) throw new Error('cancelled')
        const k = keys[i]
        const id = k.split(':')[1]
        const it = itemMap.get(id)
        if (it) await deleteResource(it, { skipConfirm: true, skipAccessCheck: true })
        updateProgress(((i + 1) / keys.length) * 100, `Deleting ${i + 1}/${keys.length}…`)
      }
      state.selected.clear()
      await remoteList(filesState.remotePath)
      hideProgress()
      return
    }
    for (let i = 0; i < keys.length; i++) {
      if (ctrl.signal.aborted) throw new Error('cancelled')
      const k = keys[i]
      const id = k.split(':')[1]
      const it = normalizeResource(state.tab, id, state.resources[state.tab][id])
      await deleteResource(it, { skipConfirm: true, skipAccessCheck: true })
      updateProgress(((i + 1) / keys.length) * 100, `Deleting ${i + 1}/${keys.length}…`)
    }
    state.selected.clear()
    await refresh()
  } catch (e) {
    if (ctrl.signal.aborted || e.message === 'cancelled') setStatus('Bulk delete cancelled', false)
    else setStatus(e.message || String(e), false)
  } finally {
    hideProgress()
  }
}

// Create waypoint at vessel position using v2 resources API.
async function createAtVesselPosition() {

  // Ensure write access
  if (!await ensureWriteAccess()) return

  if (!state.vesselPos) { setStatus('No vessel position available', false); return }

  const name = `WP ${new Date().toISOString().slice(11,19)}`
  const id = genUuid()
  const wp = buildWaypointPayload({
    id: id,
    name: name,
    description: 'Created from Navigation Manager',
    type: 'waypoint',
    position: { latitude: state.vesselPos.latitude, longitude: state.vesselPos.longitude },
  })
  try {
    setStatus('Creating...')
    const res = await fetch(`${RES_ENDPOINT('waypoints')}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wp) })
    if (!res.ok) throw new Error(`Create failed: ${res.status}`)
    await refresh()
    setStatus('Created ✔', true)
  } catch (e) { setStatus(e.message || String(e), false) }
}

// Export current items according to selected format.
async function doExport() {
  const fmtSel = $('#exportFormat').value
  const selectedOnly = $('#exportSelectedOnly').checked
  const items = selectedOnly ? state.list.filter(it => state.selected.has(`${it.type}:${it.id}`)) : state.list
  if (state.tab !== 'waypoints') { setStatus('Export currently supports waypoints only', false); return }

  const waypoints = items.map(it => ({
    id: it.id, name: it.name, description: it.description,
    latitude: it.position?.latitude, longitude: it.position?.longitude, icon: it.icon || '', type: it.wpType || '', skIcon: it.skIcon || ''
  })).filter(w => w.latitude != null && w.longitude != null)

  const ctrl = beginProgress('Exporting…')
  try {
    if (ctrl.signal.aborted) throw new Error('cancelled')
    if (fmtSel === 'csv') downloadText('waypoints.csv', toCSV(waypoints))
    if (fmtSel === 'gpx') downloadText('waypoints.gpx', toGPX({ waypoints }))
    if (fmtSel === 'kml') downloadText('waypoints.kml', toKML({ waypoints }))
    if (fmtSel === 'geojson') downloadText('waypoints.geojson', toGeoJSON({ waypoints }))
    setStatus('Exported ✔', true)
  } catch (e) {
    if (ctrl.signal.aborted || e.message === 'cancelled') setStatus('Export cancelled', false)
    else setStatus(e.message || String(e), false)
  } finally {
    hideProgress()
  }
}

// Import waypoints from uploaded file into server resources.
async function doImport() {

  // Ensure write access
  if (!await ensureWriteAccess()) return

  const fmtSel = $('#importFormat').value
  const f = $('#importFile').files?.[0]
  if (!f) { setStatus('Select a file', false); return }
  const text = await f.text()


  try {
    let items = []
    if (fmtSel === 'csv') items = parseCSV(text)
    if (fmtSel === 'gpx') items = parseGPX(text)
    if (fmtSel === 'kml') items = parseKML(text)
    if (fmtSel === 'geojson') items = parseGeoJSON(text)

    const creates = items.filter(x => x.kind === 'waypoint').map(it => {
      // …
      const item = {
        id: genUuid(),
        name: it.name || 'Waypoint',
        description: it.description || '',
        type: it.type || 'waypoint',
        position: { latitude: it.latitude, longitude: it.longitude },
        properties: it.properties || {}
      }
      console.log(item)
      return buildWaypointPayload(item)
    })
    if (!creates.length) throw new Error('No importable waypoints found')

    const ctrl = beginProgress(`Importing ${creates.length} waypoint(s)...`, { indeterminate: false })
    for (let i = 0; i < creates.length; i++) {
      if (ctrl.signal.aborted) throw new Error('cancelled')
      const c = creates[i]
      const res = await fetch(`${RES_ENDPOINT('waypoints')}/${encodeURIComponent(c.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c), signal: ctrl.signal })
      if (!res.ok) throw new Error(`Create failed: ${res.status}`)
      updateProgress(((i + 1) / creates.length) * 100, `Importing ${i + 1}/${creates.length}…`)
    }
    await refresh()
    setStatus('Imported ✔', true)
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'cancelled') setStatus('Import cancelled', false)
    else setStatus(e.message || String(e), false)
  }
  finally { $('#importFile').value = ''; hideProgress() }
}

// Switch between tabs and rerender UI.
function setTab(tab) {
  if (tab === 'files' && !hasFileRoots()) return
  state.tab = tab
  state.selected.clear()
  state.page[tab] = 1
  closeDetail()
  document.querySelectorAll('.segmented__btn').forEach(b => b.classList.toggle('segmented__btn--active', b.dataset.tab === tab))
  if (tab === 'files' && !filesState.remoteEntries.length) remoteList(filesState.remotePath, activeFileRootId())
  render()
}

// Select or clear selection for all items in current list.
function setSelectAll(on) {
  const list = getItemsForTab()
  if (on) for (const it of list) state.selected.add(`${it.type}:${it.id}`)
  else state.selected.clear()
  render()
}

// Update only waypoint distance/bearing cells to avoid rerendering actions.
function updateWaypointMetrics() {
  for (const [key, refs] of state.rows.entries()) {
    if (!key.startsWith('waypoints:')) continue
    const id = key.split(':')[1]
    const obj = state.resources.waypoints[id]
    if (!obj) continue
    const it = normalizeResource('waypoints', id, obj)
    computeDerived(it)
    if (refs.distCell) refs.distCell.textContent = formatDistance(it.distanceNm)
    if (refs.brgCell) refs.brgCell.textContent = formatBearing(it.bearing)
  }
  if (state.detail.item?.type === 'waypoints') {
    const current = state.detail.item
    const obj = state.resources.waypoints[current.id]
    if (obj) {
      const it = normalizeResource('waypoints', current.id, obj)
      computeDerived(it)
      const distEl = $('#detailDistance')
      const brgEl = $('#detailBearing')
      if (distEl) distEl.textContent = formatDistance(it.distanceNm)
      if (brgEl) brgEl.textContent = formatBearing(it.bearing)
    }
  }
}

// Wire up DOM event handlers after load.
function wire() {
  document.querySelectorAll('.segmented__btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $('#btnRefresh').addEventListener('click', () => { state.selected.clear(); refresh(); if (state.tab === 'files' && hasFileRoots()) remoteList(filesState.remotePath) })
  $('#btnPagePrev').addEventListener('click', () => { state.page[state.tab] = Math.max(1, (state.page[state.tab] || 1) - 1); render() })
  $('#btnPageNext').addEventListener('click', () => { state.page[state.tab] = (state.page[state.tab] || 1) + 1; render() })
  ;['filterText','filterWithinNm','filterType','sortBy','sortOrder'].forEach(id => {
    $(`#${id}`).addEventListener('input', () => { state.page[state.tab] = 1; render() })
    $(`#${id}`).addEventListener('change', () => { state.page[state.tab] = 1; render() })
  })
  $('#selectAll').addEventListener('change', (e) => setSelectAll(e.target.checked))
  $('#btnBulkDelete').addEventListener('click', bulkDelete)
  $('#btnCreateHere').addEventListener('click', createAtVesselPosition)

  $('#btnExport').addEventListener('click', () => $('#dlgExport').showModal())
  $('#btnImport').addEventListener('click', () => $('#dlgImport').showModal())
  // Files panel controls
  $('#btnRemoteUp')?.addEventListener('click', remoteUp)
  $('#btnRemoteMkdir')?.addEventListener('click', remoteMkdir)
  $('#remoteUpload')?.addEventListener('change', (e) => remoteUpload(e.target.files))
  $('#btnOpenTextNew')?.addEventListener('click', openNewFileDialog)
  $('#fileRootSelect')?.addEventListener('change', async (e) => {
    filesState.rootId = e.target.value
    filesState.remotePath = ''
    await remoteList('', filesState.rootId)
  })
  $('#doCreateFile')?.addEventListener('click', async (e) => {
    e.preventDefault()
    await createNewTextFile()
    $('#dlgNewFile')?.close()
  })
  $('#btnCloseDetail')?.addEventListener('click', closeDetail)
  $('#btnCloseNote')?.addEventListener('click', closeNoteView)
  $('#btnSaveDetail')?.addEventListener('click', saveDetail)

  $('#doExport').addEventListener('click', (e) => { e.preventDefault(); doExport(); $('#dlgExport').close() })
  $('#doImport').addEventListener('click', (e) => { e.preventDefault(); doImport(); $('#dlgImport').close() })
  $('#doSave').addEventListener('click', (e) => { e.preventDefault(); saveWaypoint(); $('#dlgEdit').close() })
  window.addEventListener('resize', () => render())
}

// Update metrics from websocket feed without rebuilding rows.
function handleLiveUpdate(data) {
  for (const up of (data.updates || [])) {
    for (const v of (up.values || [])) {
      if (v.path === 'navigation.position' && v.value?.latitude != null) state.vesselPos = v.value
    }
  }
  if (state.tab === 'waypoints') updateWaypointMetrics()
}

// Periodically verify websocket health.
function monitorWS() {
  if (liveSocketMonitor) clearInterval(liveSocketMonitor)
  liveSocketMonitor = setInterval(() => {
    const ready = liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)
    if (!ready) connectWS(true)
  }, WS_CHECK_INTERVAL)
}

// Establish websocket connection for live vessel position.
function connectWS(isRetry=false) {
  if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/signalk/v1/stream?subscribe=none`
  const ws = new WebSocket(url)
  liveSocket = ws
  monitorWS()
  ws.onopen = () => {
    setStatus('Live connected', true)
    ws.send(JSON.stringify({ context:'vessels.self', subscribe:[{ path:'navigation.position', period:1000 }] }))
  }
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data)
      handleLiveUpdate(data)
    } catch {}
  }
  ws.onerror = () => {
    if (liveSocket === ws) liveSocket = null
  }
  ws.onclose = () => {
    if (liveSocket === ws) liveSocket = null
    setStatus('Live disconnected (retrying)…', false)
    setTimeout(() => connectWS(true), 2000)
  }
}

// Boot sequence: load icons, wire events, refresh data, load files, and connect to websocket.
async function boot() {
  await loadConfig()
  await loadIcons()
  await loadSkIcons()
  await loadWaypointTypes()
  wire()
  await refresh()
  if (hasFileRoots()) {
    try { await remoteList('', activeFileRootId()) } catch {}
  }
  connectWS()
}
// Start the application and surface any boot errors in the status bar.
boot().catch(e => setStatus(e.message || String(e), false))
