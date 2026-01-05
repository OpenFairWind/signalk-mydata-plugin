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
  rows: new Map()
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
  // Track if combined viewer overlay should occupy the full viewport.
  viewerFullscreen: false,
  // Current viewer mode: 'preview' | 'text' | 'image'.
  viewerMode: 'preview',
  // Current working path for the editor (new or existing file).
  editorPath: '',
  // Buffer used for image editing previews (base64 w/o header).
  editorImageData: null,
  // Cached preview mime to decide available actions.
  previewMime: '',
  // Meta text for viewer header.
  viewerMetaText: 'Select a file…',
  // TinyMCE editor instance.
  tinyEditor: null,
  // Painterro instance.
  painter: null
}
// Default page sizes to avoid scrolling.
const PAGE_SIZE = 8
const FILES_PAGE_SIZE = 10

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

// Update the preview panel with metadata and provided node content.
function setPreview(metaText, node) {
  // Write meta text into the dedicated element.
  $('#previewMeta').textContent = metaText
  // Host element for body content.
  const host = $('#previewBody')
  // Clear previous children.
  host.innerHTML = ''
  // Append provided node when available.
  if (node) host.appendChild(node)
}

// Convert an ArrayBuffer to a base64 string (used for images).
function arrayBufferToBase64(buf) {
  // Wrap in typed array for iteration.
  const bytes = new Uint8Array(buf)
  // Collect binary string.
  let binary = ''
  // Walk through bytes and build binary string.
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  // Encode binary to base64.
  return btoa(binary)
}

// Initialize TinyMCE editor once and return the instance.
async function ensureTiny() {
  if (filesState.tinyEditor) return filesState.tinyEditor
  if (!window.tinymce) throw new Error('TinyMCE not loaded')
  const [inst] = await tinymce.init({
    selector: '#textEditor',
    menubar: false,
    toolbar: 'undo redo | bold italic underline | bullist numlist | alignleft aligncenter alignright | removeformat',
    height: 280,
    skin: 'oxide-dark',
    content_css: 'dark'
  })
  filesState.tinyEditor = inst
  return inst
}

// Helper to set text editor content.
async function setTextEditorValue(text) {
  try {
    const ed = await ensureTiny()
    ed.setContent((text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'))
  } catch {
    $('#textEditor').value = text || ''
  }
}

// Helper to get text editor content as plain text.
function getTextEditorValue() {
  const ed = filesState.tinyEditor
  if (ed) return ed.getContent({ format: 'text' }) || ''
  return $('#textEditor').value || ''
}

// Initialize Painterro for inline image editing.
function ensurePainter() {
  if (filesState.painter) return filesState.painter
  if (!window.Painterro) throw new Error('Painterro not loaded')
  filesState.painter = Painterro({
    id: 'imageEditorHost',
    hiddenTools: ['save', 'open', 'resize'],
    saveHandler: (image, done) => {
      filesState.editorImageData = (image.asDataURL() || '').split(',')[1]
      setStatus('Image captured', true)
      done(true)
    }
  })
  return filesState.painter
}

// Build a text preview node for the preview panel.
function previewText(text) {
  // Create preformatted container.
  const pre = document.createElement('pre')
  // Apply styling class.
  pre.className = 'preview__text'
  // Set text content to provided text or empty string.
  pre.textContent = text || ''
  // Return node for insertion.
  return pre
}

// Determine if a MIME type is previewable inline.
function isPreviewableMime(mime) {
  // Guard against falsy values and check known prefixes.
  return mime && (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/pdf')
}

// Suggest an editor mode based on MIME type.
function preferredEditorForMime(mime) {
  const m = (mime || '').toLowerCase()
  if (!m) return ''
  if (m === 'text') return 'text'
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('text/')) return 'text'
  if (m === 'application/json' || m === 'application/geo+json' || m === 'application/xml' || m === 'text/xml' || m === 'text/html' || m === 'application/xhtml+xml') return 'text'
  if (m === 'application/gpx+xml' || m === 'application/vnd.google-earth.kml+xml') return 'text'
  return ''
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
    if (filesState.viewerFullscreen) iframe.classList.add('preview__frame--full')
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
  filesState.previewMime = ''
  filesState.viewerMetaText = 'Select a file…'
  state.page.files = 1
  // Render file panels to reflect new state.
  renderFiles()
}

// Render breadcrumb text for remote navigation.
function renderCrumbs() {
  // Acquire crumb element.
  const el = $('#remoteCrumbs')
  // Normalize remote path for display.
  const p = filesState.remotePath || ''
  // Show root indicator when empty.
  el.textContent = p ? `/ ${p}` : '/ (root)'
}

// Render the remote file list with selection support.
function renderRemoteList() {
  // Host container for remote entries.
  const host = $('#remoteList')
  // Clear previous elements.
  host.innerHTML = ''
  // Paginate entries.
  const paged = paginate(filesState.remoteEntries, state.page.files, FILES_PAGE_SIZE)
  state.page.files = paged.page
  $('#filesPagerInfo').textContent = `Page ${paged.page} / ${paged.totalPages}`
  $('#btnFilesPrev').disabled = paged.page <= 1
  $('#btnFilesNext').disabled = paged.page >= paged.totalPages
  // Loop over returned entries.
  for (const e of paged.items) {
    // Create row container.
    const row = document.createElement('div')
    // Apply class for styling.
    row.className = 'fileitem'
    // Determine if this row is currently selected.
    const isSelected = filesState.selectedRemote === buildRelPath(e.name)
    // Toggle selection styling.
    row.classList.toggle('fileitem--active', isSelected)
    // Left column with badge and name.
    const left = document.createElement('div')
    left.className = 'fileitem__left'
    const badge = document.createElement('span')
    badge.className = 'muted'
    badge.textContent = e.type === 'dir' ? 'DIR' : 'FILE'
    const name = document.createElement('div')
    name.className = 'fileitem__name'
    name.textContent = e.name
    left.appendChild(badge); left.appendChild(name)

    // Metadata column for sizes.
    const meta = document.createElement('div')
    meta.className = 'fileitem__meta'
    meta.textContent = e.type === 'dir' ? '' : humanSize(e.size)

    // Actions column for per-file actions.
    const acts = document.createElement('div')
    acts.className = 'fileitem__actions'
    if (e.type === 'file') {
      const dl = document.createElement('button')
      dl.className = 'btn btn--tiny'
      dl.type = 'button'
      dl.textContent = 'Download'
      dl.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const rel = buildRelPath(e.name)
        window.open(`${API_BASE}/files/download?path=${encodeURIComponent(rel)}`, '_blank')
      })
      acts.appendChild(dl)
    }

    // Compose the row.
    row.appendChild(left)
    row.appendChild(meta)
    row.appendChild(acts)

    // Click handler for navigation or preview.
    row.addEventListener('click', async () => {
      if (e.type === 'dir') {
        const next = buildRelPath(e.name)
        await remoteList(next)
        return
      }
      const rel = buildRelPath(e.name)
      filesState.selectedRemote = rel
      await remotePreview(rel)
      renderRemoteList()
    })

    // Append row into the list.
    host.appendChild(row)
  }
}

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
    filesState.previewMime = (j.mime || j.kind || '').toLowerCase()
    filesState.editorPath = relPath
    filesState.viewerMode = 'preview'
    filesState.viewerMetaText = meta
    // Render text preview.
    if (j.kind === 'text') {
      setPreview(meta, previewText(j.text || ''))
      return
    }
    // Render binary preview when previewable.
    if (j.kind === 'binary' && j.data && isPreviewableMime(j.mime)) {
      setPreview(meta, previewBinary(j.mime, j.data))
      return
    }
    // Fallback for non-previewable binaries.
    setPreview(meta, previewText('(binary file — use Download)'))
  } catch (e) {
    // Surface preview errors in the panel.
    setPreview('Preview error', previewText(e.message || String(e)))
    filesState.viewerMetaText = 'Preview error'
    filesState.previewMime = ''
  }
  renderFiles()
}

// Render the files view (breadcrumbs, list, preview, and editor buttons).
function renderFiles() {
  // Update breadcrumb text.
  renderCrumbs()
  // Repaint remote list items.
  renderRemoteList()
  const viewer = $('#viewerPanel')
  viewer?.classList.toggle('viewer--full', filesState.viewerFullscreen)
  setHidden($('#btnExitViewport'), !filesState.viewerFullscreen)
  setHidden($('#btnViewerFullscreen'), filesState.viewerFullscreen)
  // Toggle preview/editor visibility based on mode.
  const isPreview = filesState.viewerMode === 'preview'
  const isText = filesState.viewerMode === 'text'
  const isImage = filesState.viewerMode === 'image'
  // Editing-specific toggles.
  const isEditing = isText || isImage
  const hasSelection = !!filesState.selectedRemote
  const preferred = preferredEditorForMime(filesState.previewMime)
  const allowTextEdit = !hasSelection || preferred === 'text'
  const allowImageEdit = !hasSelection || preferred === 'image'
  setHidden($('#btnSaveEditor'), !isEditing)
  setHidden($('#btnCloseEditor'), !isEditing)
  setHidden($('#btnOpenText'), isEditing)
  setHidden($('#btnOpenImage'), isEditing)
  setHidden($('#previewBlock'), !isPreview)
  setHidden($('#textEditorWrap'), !isText)
  setHidden($('#imageEditorWrap'), !isImage)
  const btnEditSel = $('#btnEditSelected')
  if (btnEditSel) btnEditSel.disabled = !hasSelection || (!allowTextEdit && !allowImageEdit)
  const btnOpenText = $('#btnOpenText')
  if (btnOpenText) btnOpenText.disabled = hasSelection && !allowTextEdit
  const btnOpenImage = $('#btnOpenImage')
  if (btnOpenImage) btnOpenImage.disabled = hasSelection && !allowImageEdit
  if (!filesState.selectedRemote && isPreview) {
    setPreview('Select a file…', previewText(''))
  }
  // Update meta label.
  const modeLabel = isPreview ? 'Preview' : (isText ? 'Text editor' : 'Image editor')
  if (isPreview && filesState.viewerMetaText) {
    $('#viewerMeta').textContent = filesState.viewerMetaText
  } else {
    $('#viewerMeta').textContent = filesState.editorPath ? `${modeLabel} — ${filesState.editorPath}` : `${modeLabel} — new file`
  }
  document.querySelectorAll('.preview__frame').forEach((el) => {
    el.classList.toggle('preview__frame--full', filesState.viewerFullscreen)
  })
}

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

// Create or overwrite an image file using base64 payload.
async function remoteSaveImage(pathRel, base64Data) {
  // Send base64 content with proper encoding flag.
  const res = await fetch(`${API_BASE}/files/write`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, content: base64Data, encoding: 'base64' }) })
  // Parse JSON body.
  const j = await res.json().catch(() => ({}))
  // Notify on failures.
  if (!res.ok || !j.ok) { setStatus(j.error || `Save failed: ${res.status}`, false); return false }
  // Success feedback to status bar.
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
  if (!dest || dest === pathRel) return
  const res = await fetch(`${API_BASE}/files/rename`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel, newPath: dest }) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ok) { setStatus(j.error || `Move failed: ${res.status}`, false); return false }
  filesState.selectedRemote = dest
  await remoteList(filesState.remotePath)
  await remotePreview(dest)
  return true
}

// Delete a remote file using server endpoint.
async function remoteDelete(pathRel) {
  // Prompt user for confirmation.
  if (!confirm(`Delete remote file "${pathRel}"?`)) return
  // Send delete request.
  const res = await fetch(`${API_BASE}/files/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: pathRel }) })
  // Parse JSON reply.
  const j = await res.json().catch(() => ({}))
  // Notify on errors.
  if (!res.ok || !j.ok) { setStatus(j.error || `Delete failed: ${res.status}`, false); return }
  // Clear selection and refresh listing.
  filesState.selectedRemote = null
  await remoteList(filesState.remotePath)
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
  const within = parseFloat($('#filterWithinNm').value || '')
  // Icon filter selection.
  const icon = ($('#filterIcon').value || '').trim()

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
    wrap.appendChild(btnTiny('edit', 'Edit', () => editWaypoint(it)))
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

// Render the current tab contents into the DOM.
function render() {
  // Determine if files tab is active.
  const isFiles = state.tab === 'files'
  // Toggle visibility of files view and tables.
  setHidden($('#filesView'), !isFiles)
  setHidden($('#tableWrap'), isFiles)
  setHidden($('#filtersPanel'), isFiles)
  setHidden($('#contentToolbar'), isFiles)
  setHidden($('#contentActions'), isFiles)
  $('#listPager').classList.toggle('hidden', isFiles)
  // Special case rendering for files tab.
  if (isFiles) {
    $('#listTitle').textContent = 'Files'
    $('#listMeta').textContent = ''
    renderFiles()
    return
  }

  // Update header text for active tab.
  $('#listTitle').textContent = state.tab[0].toUpperCase() + state.tab.slice(1)
  // Compute items and derived metrics for waypoints.
  let list = getItemsForTab().map(it => {
    if (state.tab === 'waypoints') computeDerived(it)
    return it
  })
  $('#btnCreateHere')?.setAttribute('aria-disabled', state.tab !== 'waypoints')
  if ($('#btnCreateHere')) $('#btnCreateHere').disabled = state.tab !== 'waypoints'
  if ($('#btnImport')) $('#btnImport').disabled = state.tab !== 'waypoints'
  if ($('#btnExport')) $('#btnExport').disabled = state.tab !== 'waypoints'
  // Apply filters.
  list = applyFilters(list)
  // Apply sorting.
  list = applySort(list)
  // Store list for future access.
  state.list = list
  // Apply pagination.
  const paged = paginate(list, state.page[state.tab], PAGE_SIZE)
  state.page[state.tab] = paged.page
  const viewList = paged.items
  // Update pager controls.
  $('#pagerInfo').textContent = `Page ${paged.page} / ${paged.totalPages}`
  $('#btnPagePrev').disabled = paged.page <= 1
  $('#btnPageNext').disabled = paged.page >= paged.totalPages

  // Update summary meta text.
  $('#listMeta').textContent = `${list.length} item(s) • selected: ${state.selected.size}`

  // Locate tbody for table rows.
  const tbody = $('#tbody')
  // Clear table body before rerender.
  tbody.innerHTML = ''
  // Reset row map for incremental updates.
  state.rows.clear()
  // Build rows for each item.
  for (const it of viewList) {
    const tr = document.createElement('tr')

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

    const tdIcon = document.createElement('td')
    tdIcon.appendChild(renderIconCell(it.icon))
    tr.appendChild(tdIcon)

    const tdName = document.createElement('td')
    tdName.innerHTML = `<div><strong>${escapeHtml(it.name)}</strong></div><div class="muted small">${escapeHtml(it.description || '')}</div>`
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

    // Append row into table.
    tbody.appendChild(tr)
    // Cache references for incremental metric updates.
    state.rows.set(`${it.type}:${it.id}`, { row: tr, distCell: tdDist, brgCell: tdBrg })
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
  document.querySelectorAll('.segmented__btn').forEach(b => b.classList.toggle('segmented__btn--active', b.dataset.tab === tab))
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

// Open text editor for existing or new files.
async function openTextEditor(existingPath) {
  if (existingPath && preferredEditorForMime(filesState.previewMime) !== 'text') {
    setStatus('Text editor available for text-based files only', false)
    return
  }
  filesState.viewerMode = 'text'
  filesState.editorPath = existingPath || buildRelPath('new-file.txt')
  filesState.viewerFullscreen = false
  filesState.selectedRemote = existingPath || filesState.selectedRemote
  let text = ''
  if (existingPath) {
    const res = await fetch(`${API_BASE}/files/read?path=${encodeURIComponent(existingPath)}`)
    const j = await res.json()
    if (res.ok && j.ok && j.kind === 'text') text = j.text || ''
  }
  await setTextEditorValue(text)
  renderFiles()
}

// Open image editor with a selected image file or current preview.
async function openImageEditor(existingPath) {
  if (existingPath && preferredEditorForMime(filesState.previewMime) !== 'image') {
    setStatus('Image editor available for image files only', false)
    return
  }
  filesState.viewerMode = 'image'
  filesState.editorPath = existingPath || buildRelPath('new-image.png')
  filesState.viewerFullscreen = false
  filesState.editorImageData = null
  filesState.selectedRemote = existingPath || filesState.selectedRemote
  let painter
  try {
    painter = ensurePainter()
  } catch (e) {
    setStatus(e.message || String(e), false)
    return
  }
  let mime = 'image/png'
  if (existingPath) {
    const res = await fetch(`${API_BASE}/files/read?path=${encodeURIComponent(existingPath)}`)
    const j = await res.json()
    if (res.ok && j.ok && j.kind === 'binary' && j.data) {
      filesState.editorImageData = j.data
      mime = j.mime || mime
      painter.show(`data:${mime};base64,${j.data}`)
    } else {
      painter.show()
    }
  } else {
    painter.show()
  }
  renderFiles()
}

// Persist current editor buffer to the server.
async function saveEditor() {
  if (!filesState.viewerMode || filesState.viewerMode === 'preview') return
  if (filesState.viewerMode === 'text') {
    const ok = await remoteSaveText(filesState.editorPath, getTextEditorValue())
    if (ok) await remoteList(filesState.remotePath)
  } else if (filesState.viewerMode === 'image') {
    try { filesState.painter?.save() } catch {}
    if (!filesState.editorImageData) { setStatus('Pick an image to save', false); return }
    const ok = await remoteSaveImage(filesState.editorPath, filesState.editorImageData)
    if (ok) await remoteList(filesState.remotePath)
  }
}

// Toggle fullscreen state for combined viewer.
function toggleViewerFullscreen() {
  filesState.viewerFullscreen = true
  renderFiles()
}

// Exit fullscreen viewer mode.
function exitViewerFullscreen() {
  filesState.viewerFullscreen = false
  renderFiles()
}

// Close any open editor and return to preview mode.
function closeEditors() {
  filesState.viewerMode = 'preview'
  filesState.editorPath = ''
  filesState.selectedRemote = null
  filesState.viewerMetaText = 'Select a file…'
  filesState.previewMime = ''
  setPreview('Select a file…', previewText(''))
  renderFiles()
}

// Wire up DOM event handlers after load.
function wire() {
  document.querySelectorAll('.segmented__btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $('#btnRefresh').addEventListener('click', refresh)
  $('#btnPagePrev').addEventListener('click', () => { state.page[state.tab] = Math.max(1, (state.page[state.tab] || 1) - 1); render() })
  $('#btnPageNext').addEventListener('click', () => { state.page[state.tab] = (state.page[state.tab] || 1) + 1; render() })
  ;['filterText','filterWithinNm','filterIcon','sortBy','sortOrder'].forEach(id => {
    $(`#${id}`).addEventListener('input', () => { state.page[state.tab] = 1; render() })
    $(`#${id}`).addEventListener('change', () => { state.page[state.tab] = 1; render() })
  })
  $('#selectAll').addEventListener('change', (e) => setSelectAll(e.target.checked))
  $('#selectAllHeader').addEventListener('change', (e) => setSelectAll(e.target.checked))
  $('#btnBulkDelete').addEventListener('click', bulkDelete)
  $('#btnCreateHere').addEventListener('click', createAtVesselPosition)

  $('#btnExport').addEventListener('click', () => $('#dlgExport').showModal())
  $('#btnImport').addEventListener('click', () => $('#dlgImport').showModal())
  // Files panel controls
  $('#btnRemoteUp')?.addEventListener('click', remoteUp)
  $('#btnRemoteRefresh')?.addEventListener('click', () => remoteList(filesState.remotePath))
  $('#btnRemoteMkdir')?.addEventListener('click', remoteMkdir)
  $('#remoteUpload')?.addEventListener('change', (e) => remoteUpload(e.target.files))
  $('#btnFilesPrev')?.addEventListener('click', () => { state.page.files = Math.max(1, (state.page.files || 1) - 1); renderFiles() })
  $('#btnFilesNext')?.addEventListener('click', () => { state.page.files = (state.page.files || 1) + 1; renderFiles() })
  $('#btnOpenTextNew')?.addEventListener('click', () => openTextEditor())
  $('#btnOpenImageNew')?.addEventListener('click', () => openImageEditor())
  $('#btnEditSelected')?.addEventListener('click', () => {
    if (!filesState.selectedRemote) { setStatus('Select a remote file to edit', false); return }
    const pref = preferredEditorForMime(filesState.previewMime)
    if (pref === 'image') openImageEditor(filesState.selectedRemote)
    else if (pref === 'text') openTextEditor(filesState.selectedRemote)
    else setStatus('Editing available for text or image files only', false)
  })
  $('#btnMoveSelected')?.addEventListener('click', () => {
    if (!filesState.selectedRemote) { setStatus('Select a file first', false); return }
    remoteMove(filesState.selectedRemote)
  })
  $('#btnRenameSelected')?.addEventListener('click', async () => {
    if (!filesState.selectedRemote) { setStatus('Select a file first', false); return }
    const base = filesState.selectedRemote.split('/').pop()
    const name = prompt('New name:', base)
    if (!name) return
    await remoteRename(filesState.selectedRemote, name)
  })
  $('#btnDeleteSelected')?.addEventListener('click', () => {
    if (!filesState.selectedRemote) { setStatus('Select a file first', false); return }
    remoteDelete(filesState.selectedRemote)
  })
  $('#btnViewerFullscreen')?.addEventListener('click', toggleViewerFullscreen)
  $('#btnExitViewport')?.addEventListener('click', exitViewerFullscreen)
  $('#btnOpenText')?.addEventListener('click', () => openTextEditor(filesState.selectedRemote || ''))
  $('#btnOpenImage')?.addEventListener('click', () => openImageEditor(filesState.selectedRemote || ''))
  $('#btnCloseEditor')?.addEventListener('click', closeEditors)
  $('#btnSaveEditor')?.addEventListener('click', saveEditor)

  $('#doExport').addEventListener('click', (e) => { e.preventDefault(); doExport(); $('#dlgExport').close() })
  $('#doImport').addEventListener('click', (e) => { e.preventDefault(); doImport(); $('#dlgImport').close() })
  $('#doSave').addEventListener('click', (e) => { e.preventDefault(); saveWaypoint(); $('#dlgEdit').close() })
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
