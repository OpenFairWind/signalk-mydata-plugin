// Import helper utilities for formatting numbers, calculating distances/bearings, downloading text, and parsing/serializing formats.
import { haversineNm, bearingDeg, fmt, downloadText, parseCSV, toCSV, parseGPX, toGPX, parseKML, toKML, parseGeoJSON, toGeoJSON } from './formats.js'
// Shorthand query selector helper to keep DOM lookups concise.
const $ = (sel) => document.querySelector(sel)

// Constant for plugin identification inside URLs.
const PLUGIN_ID = 'signalk-mydata-plugin'
// Base path for plugin-relative API endpoints.
const API_BASE = `/plugins/${PLUGIN_ID}`

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
  // Mapping from resource key to DOM row for incremental updates.
  rows: new Map(),
  // Detail panel state.
  detail: { item: null, edit: false, preview: null, isNew: false }
}
// Websocket monitor handles.
const WS_CHECK_INTERVAL = 7000
let liveSocket = null
let liveSocketMonitor = null
// Helper to build fully qualified Signal K v2 resource endpoints.
const RES_ENDPOINT = (type) => `/signalk/v2/api/resources/${type}`

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

// State dedicated to remote file operations and editors.
const filesState = {
  // Current remote path (relative to configured root).
  remotePath: '',
  // Entries returned by the server for the current path.
  remoteEntries: [],
  // Currently selected remote file path (relative).
  selectedRemote: null,
  // TinyMCE editor instance.
  tinyEditor: null
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

// Initialize TinyMCE editor once and return the instance.
async function ensureTiny(selector = '#detailTextEditor') {
  if (filesState.tinyEditor) return filesState.tinyEditor
  if (!window.tinymce) throw new Error('TinyMCE not loaded')
  const [inst] = await tinymce.init({
    selector,
    menubar: false,
    toolbar: 'undo redo | bold italic underline | bullist numlist | alignleft aligncenter alignright | removeformat',
    height: 320,
    skin: 'oxide-dark',
    content_css: 'dark'
  })
  filesState.tinyEditor = inst
  return inst
}

// Helper to set text editor content.
async function setTextEditorValue(text, selector = '#detailTextEditor') {
  try {
    const ed = await ensureTiny(selector)
    const safe = (text || '').split('\n').map(line => (line || '').
      replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') || '&nbsp;')
    ed.setContent(safe.map(l => `<div>${l}</div>`).join('') || '<div><br></div>')
  } catch {
    const el = document.querySelector(selector)
    if (el) el.value = text || ''
  }
}

// Helper to get text editor content as plain text.
function getTextEditorValue(selector = '#detailTextEditor') {
  const ed = filesState.tinyEditor
  if (ed) return ed.getContent({ format: 'text' }) || ''
  const el = document.querySelector(selector)
  if (el) return el.value || ''
  return ''
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
async function remoteList(pathRel='') {
  // Request listing from server.
  const res = await fetch(`${API_BASE}/files/list?path=${encodeURIComponent(pathRel)}`)
  // Parse JSON payload.
  const j = await res.json()
  // Throw on failure so caller can surface status.
  if (!res.ok || !j.ok) throw new Error(j.error || `List failed: ${res.status}`)
  // Persist path and entries for rendering.
  filesState.remotePath = j.path || ''
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
  // Show root indicator when empty.
  return p ? `/ ${p}` : '/ (root)'
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
async function remotePreview(relPath) {
  try {
    // Request file preview payload.
    const res = await fetch(`${API_BASE}/files/read?path=${encodeURIComponent(relPath)}`)
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
  // Ask the user for a folder name.
  const name = prompt('New folder name:')
  // Abort when cancelled or empty.
  if (!name) return
  // Compose relative path for creation.
  const rel = buildRelPath(name)
  // Issue mkdir request.
  const res = await fetch(`${API_BASE}/files/mkdir`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: rel }) })
  // Parse JSON response.
  const j = await res.json().catch(() => ({}))
  // Surface errors via status bar.
  if (!res.ok || !j.ok) { setStatus(j.error || `mkdir failed: ${res.status}`, false); return }
  // Refresh listing on success.
  await remoteList(filesState.remotePath)
}

// Upload one or more files directly into the current remote directory.
async function remoteUpload(files) {
  // Ignore when nothing selected.
  if (!files || !files.length) return
  // Prepare multipart form data.
  const fd = new FormData()
  // Append directory path.
  fd.append('dir', filesState.remotePath || '')
  // Append every file using shared field name.
  for (const f of files) fd.append('file', f, f.name)
  // POST to upload endpoint.
  const res = await fetch(`${API_BASE}/files/upload`, { method:'POST', body: fd })
  // Parse JSON reply.
  const j = await res.json().catch(() => ({}))
  // Signal errors in UI.
  if (!res.ok || !j.ok) { setStatus(j.error || `upload failed: ${res.status}`, false); return }
  // Inform user of success and refresh listing.
  setStatus('Uploaded ✔', true)
  await remoteList(filesState.remotePath)
}

// Create or overwrite a text file on the server.
async function remoteSaveText(pathRel, text) {
  // Issue write request with utf8 encoding.
  const res = await fetch(`${API_BASE}/files/write`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, content: text, encoding: 'utf8' }) })
  // Parse response JSON for ok flag.
  const j = await res.json().catch(() => ({}))
  // Raise user-visible error on failure.
  if (!res.ok || !j.ok) { setStatus(j.error || `Save failed: ${res.status}`, false); return false }
  // Inform success.
  setStatus('Saved ✔', true)
  return true
}

// Rename a remote file by supplying new path.
async function remoteRename(pathRel, newName) {
  // Compute new relative path in current directory.
  const newRel = buildRelPath(newName)
  // Perform rename via dedicated endpoint.
  const res = await fetch(`${API_BASE}/files/rename`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, newPath: newRel }) })
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
  const dest = prompt('Move to path (relative to root):', pathRel)
  if (!dest || dest === pathRel) return null
  const res = await fetch(`${API_BASE}/files/rename`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, newPath: dest }) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ok) { setStatus(j.error || `Move failed: ${res.status}`, false); return null }
  filesState.selectedRemote = dest
  await remoteList(filesState.remotePath)
  return dest
}

// Delete a remote file using server endpoint.
async function remoteDelete(pathRel, confirmDelete = true) {
  // Prompt user for confirmation.
  if (confirmDelete && !confirm(`Delete remote file "${pathRel}"?`)) return false
  // Send delete request.
  const res = await fetch(`${API_BASE}/files/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel }) })
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

// Load OpenBridge icon manifest and wire select options/mask images.
async function loadIcons() {
  // Fetch manifest with cache busting.
  const res = await fetch('./icons.json', { cache: 'no-cache' })
  // Store manifest JSON.
  state.icons = await res.json()

  // Populate select elements for filter and edit dialogs.
  for (const sel of [$('#filterIcon'), $('#editIcon')]) {
    sel.innerHTML = ''
    const optAny = document.createElement('option')
    optAny.value = ''
    optAny.textContent = sel.id === 'editIcon' ? '— choose —' : 'Any'
    sel.appendChild(optAny)

    for (const ic of state.icons.icons) {
      const o = document.createElement('option')
      o.value = ic.id
      o.textContent = ic.label
      sel.appendChild(o)
    }
  }

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
  item.icon = (obj.properties && obj.properties.icon) || obj.icon || ''
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
function buildWaypointPayload({ id, name, description, position, icon, existing }) {
  const payload = existing ? JSON.parse(JSON.stringify(existing)) : {}
  if (id) payload.id = id
  if (name !== undefined) payload.name = name
  if (description !== undefined) payload.description = description

  const lat = Number(position?.latitude)
  const lon = Number(position?.longitude)
  const hasCoords = !Number.isNaN(lat) && !Number.isNaN(lon)

  if (hasCoords) {
    payload.position = { latitude: lat, longitude: lon }
    payload.feature = payload.feature || {}
    payload.feature.type = 'Feature'
    payload.feature.geometry = { type: 'Point', coordinates: [lon, lat] }
    const fp = { ...(payload.feature.properties || {}) }
    fp.kind = 'waypoint'
    if (name !== undefined) fp.name = name
    if (description !== undefined) fp.description = description
    if (icon) fp.icon = icon
    payload.feature.properties = fp
  }

  const props = { ...(payload.properties || {}) }
  if (icon) props.icon = icon
  else delete props.icon
  if (Object.keys(props).length) payload.properties = props
  else delete payload.properties

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
  const within = state.tab === 'files' ? NaN : parseFloat($('#filterWithinNm').value || '')
  // Icon filter selection.
  const icon = state.tab === 'files' ? '' : ($('#filterIcon').value || '').trim()

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

// Render an icon cell using loaded manifest.
function renderIconCell(iconId) {
  // Wrapper span for icon image.
  const wrap = document.createElement('span')
  // Assign styling class.
  wrap.className = 'imgicon'
  // Find matching icon metadata.
  const ic = (state.icons?.icons || []).find(x => x.id === iconId)
  // Fallback text when icon missing.
  if (!ic) { wrap.textContent = '—'; wrap.classList.add('muted'); return wrap }
  // Build image element.
  const img = document.createElement('img')
  img.src = state.icons.baseUrl + ic.path
  img.alt = ic.label
  img.style.filter = 'invert(1)'
  wrap.appendChild(img)
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
  const ic = state.icons.icons.find(x => x.id === iconId)
  if (ic) {
    const url = state.icons.baseUrl + ic.path
    const el = b.querySelector('.icon')
    el.style.webkitMaskImage = `url(${url})`
    el.style.maskImage = `url(${url})`
  }
  return b
}

// Render action buttons for a given item.
function renderActions(it) {
  // Container for inline row actions.
  const wrap = document.createElement('div')
  wrap.className = 'row-actions'
  if (it.type === 'waypoints') {
    wrap.appendChild(btnTiny('goto', 'Go to', () => gotoWaypoint(it)))
    wrap.appendChild(btnTiny('map', 'Show on map', () => showOnMap(it)))
  } else if (it.type === 'files') {
    if (it.fileType === 'file') {
      wrap.appendChild(btnTiny('download', 'Download', (ev) => {
        ev.stopPropagation()
        window.open(`${API_BASE}/files/download?path=${encodeURIComponent(it.id)}`, '_blank')
      }))
    }
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

// Clear detail panel and TinyMCE instance.
function closeDetail() {
  const panel = $('#detailPanel')
  if (panel) panel.classList.add('hidden')
  if (filesState.tinyEditor?.remove) filesState.tinyEditor.remove()
  filesState.tinyEditor = null
  state.detail = { item: null, preview: null, edit: false, isNew: false }
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
function buildIconSelect(selected = '') {
  const sel = document.createElement('select')
  sel.id = 'detailEditIcon'
  const blank = document.createElement('option')
  blank.value = ''
  blank.textContent = '— choose —'
  sel.appendChild(blank)
  for (const ic of state.icons?.icons || []) {
    const o = document.createElement('option')
    o.value = ic.id
    o.textContent = ic.label
    if (ic.id === selected) o.selected = true
    sel.appendChild(o)
  }
  return sel
}

// Render the waypoint detail view.
function renderWaypointDetail(it, editMode) {
  const table = document.createElement('table')
  table.className = 'proptable'
  const raw = state.resources.waypoints?.[it.id] || it.raw || {}

  const nameField = editMode ? (() => {
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.id = 'detailEditName'
    inp.value = raw.name || ''
    return inp
  })() : document.createTextNode(raw.name || it.name || '')

  const descField = editMode ? (() => {
    const ta = document.createElement('textarea')
    ta.id = 'detailEditDesc'
    ta.rows = 3
    ta.value = raw.description || it.description || ''
    return ta
  })() : document.createTextNode(raw.description || it.description || '')

  const latField = editMode ? (() => {
    const inp = document.createElement('input')
    inp.type = 'number'
    inp.step = '0.000001'
    inp.id = 'detailEditLat'
    inp.value = raw.position?.latitude ?? it.position?.latitude ?? ''
    return inp
  })() : document.createTextNode((raw.position?.latitude ?? it.position?.latitude ?? '—').toString())

  const lonField = editMode ? (() => {
    const inp = document.createElement('input')
    inp.type = 'number'
    inp.step = '0.000001'
    inp.id = 'detailEditLon'
    inp.value = raw.position?.longitude ?? it.position?.longitude ?? ''
    return inp
  })() : document.createTextNode((raw.position?.longitude ?? it.position?.longitude ?? '—').toString())

  const iconField = editMode ? buildIconSelect(it.icon || raw.properties?.icon || '') : document.createTextNode(it.icon || raw.properties?.icon || '—')

  table.appendChild(propRow('Name', nameField))
  table.appendChild(propRow('Description', descField))
  table.appendChild(propRow('Latitude', latField))
  table.appendChild(propRow('Longitude', lonField))
  table.appendChild(propRow('Icon', iconField))
  return table
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
async function renderFileDetail(it, preview, editMode, isNew) {
  const frag = document.createDocumentFragment()
  const table = document.createElement('table')
  table.className = 'proptable'
  table.appendChild(propRow('Path', document.createTextNode(it.id)))
  table.appendChild(propRow('Type', document.createTextNode(it.fileType)))
  if (preview?.mime) table.appendChild(propRow('MIME', document.createTextNode(preview.mime)))
  if (it.fileType === 'file' && it.size != null) table.appendChild(propRow('Size', document.createTextNode(humanSize(it.size))))
  if (it.modified) table.appendChild(propRow('Modified', document.createTextNode(new Date(it.modified).toLocaleString())))
  frag.appendChild(table)

  const pathField = document.createElement('input')
  pathField.type = 'text'
  pathField.id = 'detailFilePath'
  pathField.value = it.id
  pathField.className = 'textfield'
  const saveTable = document.createElement('table')
  saveTable.className = 'proptable'
  saveTable.appendChild(propRow('Save as', pathField))
  frag.appendChild(saveTable)

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

  if (preview?.kind === 'text' || editMode || isNew) {
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

  if (preview?.kind === 'binary' && preview.data && isPreviewableMime(preview.mime)) {
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
  $('#detailTitle').textContent = `${item.type.slice(0, -1).toUpperCase()}: ${item.name}`
  $('#detailMeta').textContent = item.type === 'files' ? (preview?.meta || renderCrumbs()) : ``
  const actions = $('#detailActions')
  const body = $('#detailBody')
  actions.innerHTML = ''
  body.innerHTML = ''
  let saveable = false
  saveBtn.classList.add('hidden')

  if (item.type === 'waypoints') {
    actions.appendChild(btnTiny('goto', 'Go to', () => gotoWaypoint(item)))
    actions.appendChild(btnTiny('map', 'Show on map', () => showOnMap(item)))
    const toggleEdit = btnTiny(edit ? 'close' : 'edit', 'Edit', async () => { state.detail.edit = !state.detail.edit; await renderDetail() })
    actions.appendChild(toggleEdit)
    actions.appendChild(btnTiny('trash', 'Delete', () => deleteResource(item)))
    body.appendChild(renderWaypointDetail(item, edit))
    saveable = edit
  } else if (item.type === 'routes') {
    actions.appendChild(btnTiny('trash', 'Delete', () => deleteResource(item)))
    body.appendChild(renderRouteDetail(item))
  } else if (item.type === 'files') {
    if (item.fileType === 'file') {
      actions.appendChild(btnTiny('download', 'Download', () => window.open(`${API_BASE}/files/download?path=${encodeURIComponent(item.id)}`, '_blank')))
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
    const fileDetail = await renderFileDetail(item, preview, edit, isNew)
    saveable = fileDetail.saveable
    body.appendChild(fileDetail.node)
  }

  if (saveable) saveBtn.classList.remove('hidden')
}

// Open the detail overlay for a given item.
async function openDetail(it, opts = {}) {
  filesState.tinyEditor?.remove?.()
  filesState.tinyEditor = null
  state.detail = { item: it, preview: null, edit: !!opts.edit, isNew: !!opts.isNew }
  try {
    if (it.type === 'files') {
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
      state.detail.preview = { raw: state.resources.waypoints?.[it.id] || it.raw }
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
  const { item } = state.detail
  if (!item) return
  if (item.type === 'waypoints') {
    const name = $('#detailEditName')?.value?.trim()
    const description = $('#detailEditDesc')?.value?.trim()
    const lat = parseFloat($('#detailEditLat')?.value)
    const lon = parseFloat($('#detailEditLon')?.value)
    const icon = $('#detailEditIcon')?.value?.trim()
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) { setStatus('Missing name/position', false); return }
    const orig = state.resources.waypoints[item.id]
    if (!orig) { setStatus('Waypoint not found in cache', false); return }
    const updated = buildWaypointPayload({
      id: item.id,
      name,
      description,
      position: { latitude: lat, longitude: lon },
      icon,
      existing: orig
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
    headRow.innerHTML = `
      <th style="width:40px"><input type="checkbox" id="selectAllHeader" /></th>
      <th>Icon</th>
      <th>Name</th>
      <th class="num" style="text-align:right">Dist (NM)</th>
      <th class="num" style="text-align:right">Brg (°)</th>
      <th>Actions</th>`
  }
  headRow.querySelector('#selectAllHeader')?.addEventListener('change', (e) => setSelectAll(e.target.checked))
}

// Render the current tab contents into the DOM.
function render() {
  // Determine if files tab is active.
  const isFiles = state.tab === 'files'
  // Update header text for active tab.
  $('#listTitle').textContent = state.tab[0].toUpperCase() + state.tab.slice(1)

  // Toggle action bars.
  $('#navActions')?.classList.toggle('hidden', isFiles)
  $('#fileActions')?.classList.toggle('hidden', !isFiles)

  // Toggle filter fields that are navigation-specific.
  const withinField = $('#filterWithinNm')?.closest('.field')
  const iconField = $('#filterIcon')?.closest('.field')
  if (withinField) setHidden(withinField, isFiles)
  if (iconField) setHidden(iconField, isFiles)

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
      tdDist.textContent = it.distanceNm == null ? '—' : fmt(it.distanceNm, 2)
      tr.appendChild(tdDist)

      const tdBrg = document.createElement('td')
      tdBrg.className = 'num'
      tdBrg.textContent = it.bearing == null ? '—' : fmt(it.bearing, 0)
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
  $('#editIcon').value = it.icon || ''
  dlg.showModal()
}

// Persist waypoint changes back to the server.
async function saveWaypoint() {
  const id = $('#dlgEdit').dataset.id
  const name = $('#editName').value.trim()
  const description = $('#editDesc').value.trim()
  const lat = parseFloat($('#editLat').value)
  const lon = parseFloat($('#editLon').value)
  const icon = $('#editIcon').value.trim()
  if (!id || !name || Number.isNaN(lat) || Number.isNaN(lon)) { setStatus('Missing name/position', false); return }

  const orig = state.resources.waypoints[id]
  if (!orig) { setStatus('Waypoint not found in cache', false); return }

  const updated = buildWaypointPayload({
    id,
    name,
    description,
    position: { latitude: lat, longitude: lon },
    icon,
    existing: orig
  })

  try {
    setStatus('Saving…')
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
async function deleteResource(it) {
  try {
    if (!confirm(`Delete ${it.type.slice(0,-1)} "${it.name}"?`)) return
    setStatus('Deleting…')
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
  const keys = [...state.selected].filter(k => k.startsWith(state.tab + ':'))
  if (!keys.length) return
  if (!confirm(`Delete ${keys.length} selected ${state.tab}?`)) return
  if (state.tab === 'files') {
    const itemMap = new Map(getItemsForTab().map(it => [it.id, it]))
    for (const k of keys) {
      const id = k.split(':')[1]
      const it = itemMap.get(id)
      if (it) await deleteResource(it)
    }
    state.selected.clear()
    await remoteList(filesState.remotePath)
    return
  }
  for (const k of keys) {
    const id = k.split(':')[1]
    const it = normalizeResource(state.tab, id, state.resources[state.tab][id])
    await deleteResource(it)
  }
  state.selected.clear()
  await refresh()
}

// Create waypoint at vessel position using v2 resources API.
async function createAtVesselPosition() {
  if (!state.vesselPos) { setStatus('No vessel position available', false); return }
  const name = `WP ${new Date().toISOString().slice(11,19)}`
  const id = genUuid()
  const wp = buildWaypointPayload({
    id,
    name,
    description: 'Created from Navigation Manager',
    position: { latitude: state.vesselPos.latitude, longitude: state.vesselPos.longitude },
    icon: 'waypoint'
  })
  try {
    setStatus('Creating…')
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
    latitude: it.position?.latitude, longitude: it.position?.longitude, icon: it.icon || ''
  })).filter(w => w.latitude != null && w.longitude != null)

  if (fmtSel === 'csv') downloadText('waypoints.csv', toCSV(waypoints))
  if (fmtSel === 'gpx') downloadText('waypoints.gpx', toGPX({ waypoints }))
  if (fmtSel === 'kml') downloadText('waypoints.kml', toKML({ waypoints }))
  if (fmtSel === 'geojson') downloadText('waypoints.geojson', toGeoJSON({ waypoints }))
  setStatus('Exported ✔', true)
}

// Import waypoints from uploaded file into server resources.
async function doImport() {
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
      const uuid = genUuid()
      return buildWaypointPayload({
        id: uuid,
        name: it.name || 'Waypoint',
        description: it.description || '',
        position: { latitude: it.latitude, longitude: it.longitude },
        icon: it.icon || 'waypoint'
      })
    })
    if (!creates.length) throw new Error('No importable waypoints found')

    setStatus(`Importing ${creates.length} waypoint(s)…`)
    for (const c of creates) {
      const res = await fetch(`${RES_ENDPOINT('waypoints')}/${encodeURIComponent(c.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) })
      if (!res.ok) throw new Error(`Create failed: ${res.status}`)
    }
    await refresh()
    setStatus('Imported ✔', true)
  } catch (e) { setStatus(e.message || String(e), false) }
  finally { $('#importFile').value = '' }
}

// Switch between tabs and rerender UI.
function setTab(tab) {
  state.tab = tab
  state.selected.clear()
  state.page[tab] = 1
  closeDetail()
  document.querySelectorAll('.segmented__btn').forEach(b => b.classList.toggle('segmented__btn--active', b.dataset.tab === tab))
  if (tab === 'files' && !filesState.remoteEntries.length) remoteList(filesState.remotePath)
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
    if (refs.distCell) refs.distCell.textContent = it.distanceNm == null ? '—' : fmt(it.distanceNm, 2)
    if (refs.brgCell) refs.brgCell.textContent = it.bearing == null ? '—' : fmt(it.bearing, 0)
  }
}

// Wire up DOM event handlers after load.
function wire() {
  document.querySelectorAll('.segmented__btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $('#btnRefresh').addEventListener('click', () => { state.selected.clear(); refresh(); if (state.tab === 'files') remoteList(filesState.remotePath) })
  $('#btnPagePrev').addEventListener('click', () => { state.page[state.tab] = Math.max(1, (state.page[state.tab] || 1) - 1); render() })
  $('#btnPageNext').addEventListener('click', () => { state.page[state.tab] = (state.page[state.tab] || 1) + 1; render() })
  ;['filterText','filterWithinNm','filterIcon','sortBy','sortOrder'].forEach(id => {
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
  $('#btnOpenTextNew')?.addEventListener('click', () => openDetail({ type: 'files', id: buildRelPath('new-file.txt'), name: 'new-file.txt', fileType: 'file', size: 0, modified: null, description: '', raw: { name: 'new-file.txt', type: 'file' } }, { edit: true, isNew: true }))
  $('#btnCloseDetail')?.addEventListener('click', closeDetail)
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
  await loadIcons()
  wire()
  await refresh()
  try { await remoteList('') } catch {}
  connectWS()
}
// Start the application and surface any boot errors in the status bar.
boot().catch(e => setStatus(e.message || String(e), false))
