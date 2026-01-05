import { haversineNm, bearingDeg, fmt, downloadText, parseCSV, toCSV, parseGPX, toGPX, parseKML, toKML, parseGeoJSON, toGeoJSON } from './formats.js'
const $ = (sel) => document.querySelector(sel)

const PLUGIN_ID = 'signalk-mydata-plugin'
const API_BASE = `/plugins/${PLUGIN_ID}`

const state = {
  tab: 'waypoints',
  resources: { waypoints: {}, routes: {}, tracks: {} },
  list: [],
  selected: new Set(),
  vesselPos: null,
  icons: null
}
const RES_ENDPOINT = (type) => `/signalk/v2/api/resources/${type}`

const filesState = {
  remotePath: '',
  remoteEntries: [],
  localFiles: [],
  selectedRemote: null
}

function humanSize(bytes) {
  if (bytes == null) return ''
  const units = ['B','KB','MB','GB']
  let b = Number(bytes)
  let u = 0
  while (b >= 1024 && u < units.length-1) { b /= 1024; u++ }
  return `${b.toFixed(u===0?0:1)} ${units[u]}`
}

function setHidden(el, hidden) {
  if (!el) return
  el.classList.toggle('hidden', hidden)
}

function setPreview(metaText, node) {
  $('#previewMeta').textContent = metaText
  const host = $('#previewBody')
  host.innerHTML = ''
  if (node) host.appendChild(node)
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function previewText(text) {
  const pre = document.createElement('pre')
  pre.className = 'preview__text'
  pre.textContent = text || ''
  return pre
}

function isPreviewableMime(mime) {
  return mime && (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/pdf')
}

function previewBinary(mime, data) {
  const wrap = document.createElement('div')
  wrap.className = 'preview__binary'
  if (!mime || !data) {
    wrap.textContent = 'Binary file — use Download'
    wrap.classList.add('muted')
    return wrap
  }

  const dataUrl = `data:${mime};base64,${data}`
  if (mime.startsWith('image/')) {
    const img = new Image()
    img.src = dataUrl
    img.alt = 'Preview'
    img.className = 'preview__media'
    wrap.appendChild(img)
    return wrap
  }
  if (mime.startsWith('audio/')) {
    const audio = document.createElement('audio')
    audio.controls = true
    audio.src = dataUrl
    audio.style.width = '100%'
    wrap.appendChild(audio)
    return wrap
  }
  if (mime.startsWith('video/')) {
    const video = document.createElement('video')
    video.controls = true
    video.src = dataUrl
    video.style.width = '100%'
    video.style.maxHeight = '200px'
    wrap.appendChild(video)
    return wrap
  }
  if (mime === 'application/pdf') {
    const iframe = document.createElement('iframe')
    iframe.src = dataUrl
    iframe.className = 'preview__frame'
    wrap.appendChild(iframe)
    return wrap
  }
  wrap.textContent = 'Binary file — use Download'
  wrap.classList.add('muted')
  return wrap
}

async function remoteList(pathRel='') {
  const res = await fetch(`${API_BASE}/files/list?path=${encodeURIComponent(pathRel)}`)
  const j = await res.json()
  if (!res.ok || !j.ok) throw new Error(j.error || `List failed: ${res.status}`)
  filesState.remotePath = j.path || ''
  filesState.remoteEntries = j.entries || []
  filesState.selectedRemote = null
  renderFiles()
}

function renderCrumbs() {
  const el = $('#remoteCrumbs')
  const p = filesState.remotePath || ''
  el.textContent = p ? `/ ${p}` : '/ (root)'
}

function renderRemoteList() {
  const host = $('#remoteList')
  host.innerHTML = ''
  for (const e of filesState.remoteEntries) {
    const row = document.createElement('div')
    row.className = 'fileitem'
    const left = document.createElement('div')
    left.className = 'fileitem__left'
    const badge = document.createElement('span')
    badge.className = 'muted'
    badge.textContent = e.type === 'dir' ? 'DIR' : 'FILE'
    const name = document.createElement('div')
    name.className = 'fileitem__name'
    name.textContent = e.name
    left.appendChild(badge); left.appendChild(name)

    const meta = document.createElement('div')
    meta.className = 'fileitem__meta'
    meta.textContent = e.type === 'dir' ? '' : humanSize(e.size)

    const acts = document.createElement('div')
    acts.className = 'fileitem__actions'
    if (e.type === 'file') {
      const dl = document.createElement('button')
      dl.className = 'btn btn--tiny'
      dl.type = 'button'
      dl.textContent = 'Download'
      dl.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const rel = (filesState.remotePath ? (filesState.remotePath.replace(/\/+$/,'') + '/') : '') + e.name
        window.open(`${API_BASE}/files/download?path=${encodeURIComponent(rel)}`, '_blank')
      })
      acts.appendChild(dl)
    }

    row.appendChild(left)
    row.appendChild(meta)
    row.appendChild(acts)

    row.addEventListener('click', async () => {
      if (e.type === 'dir') {
        const next = (filesState.remotePath ? (filesState.remotePath.replace(/\/+$/,'') + '/') : '') + e.name
        await remoteList(next)
        return
      }
      const rel = (filesState.remotePath ? (filesState.remotePath.replace(/\/+$/,'') + '/') : '') + e.name
      await remotePreview(rel)
    })

    host.appendChild(row)
  }
}

async function remotePreview(relPath) {
  try {
    const res = await fetch(`${API_BASE}/files/read?path=${encodeURIComponent(relPath)}`)
    const j = await res.json()
    if (!res.ok || !j.ok) throw new Error(j.error || `Read failed: ${res.status}`)
    filesState.selectedRemote = relPath
    const meta = `${relPath} • ${j.mime || j.kind} • ${humanSize(j.size)}`
    if (j.kind === 'text') {
      setPreview(meta, previewText(j.text || ''))
      return
    }
    if (j.kind === 'binary' && j.data && isPreviewableMime(j.mime)) {
      setPreview(meta, previewBinary(j.mime, j.data))
      return
    }
    setPreview(meta, previewText('(binary file — use Download)'))
  } catch (e) {
    setPreview('Preview error', previewText(e.message || String(e)))
  }
}

function renderLocalList() {
  const host = $('#localList')
  host.innerHTML = ''
  for (const f of filesState.localFiles) {
    const row = document.createElement('div')
    row.className = 'fileitem'
    const left = document.createElement('div')
    left.className = 'fileitem__left'
    const badge = document.createElement('span')
    badge.className = 'muted'
    badge.textContent = 'LOCAL'
    const name = document.createElement('div')
    name.className = 'fileitem__name'
    name.textContent = f.name
    left.appendChild(badge); left.appendChild(name)

    const meta = document.createElement('div')
    meta.className = 'fileitem__meta'
    meta.textContent = humanSize(f.size)

    const acts = document.createElement('div')
    acts.className = 'fileitem__actions'
    const open = document.createElement('button')
    open.className = 'btn btn--tiny'
    open.type = 'button'
    open.textContent = 'Preview'
    open.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const meta = `${f.name} • local • ${humanSize(f.size)}`
      if (f.size > 2 * 1024 * 1024) {
        setPreview(meta, previewText('File too large for inline preview'))
        return
      }
      if (f.type && isPreviewableMime(f.type)) {
        const data = await f.arrayBuffer()
        const b64 = arrayBufferToBase64(data)
        setPreview(meta, previewBinary(f.type, b64))
        return
      }
      const text = await f.text().catch(() => null)
      setPreview(meta, previewText(text ?? '(binary file)'))
    })
    acts.appendChild(open)

    row.appendChild(left); row.appendChild(meta); row.appendChild(acts)
    host.appendChild(row)
  }
}

function renderFiles() {
  renderCrumbs()
  renderRemoteList()
  renderLocalList()
}

async function remoteUp() {
  const p = (filesState.remotePath || '').replace(/\/+$/,'')
  if (!p) return
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  await remoteList(parts.join('/'))
}

async function remoteMkdir() {
  const name = prompt('New folder name:')
  if (!name) return
  const pfx = (filesState.remotePath ? filesState.remotePath.replace(/\/+$/,'') + '/' : '')
  const rel = pfx + name
  const res = await fetch(`${API_BASE}/files/mkdir`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: rel }) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ok) { setStatus(j.error || `mkdir failed: ${res.status}`, false); return }
  await remoteList(filesState.remotePath)
}

async function remoteUpload(files) {
  if (!files || !files.length) return
  const fd = new FormData()
  fd.append('dir', filesState.remotePath || '')
  for (const f of files) fd.append('file', f, f.name)
  const res = await fetch(`${API_BASE}/files/upload`, { method:'POST', body: fd })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ok) { setStatus(j.error || `upload failed: ${res.status}`, false); return }
  setStatus('Uploaded ✔', true)
  await remoteList(filesState.remotePath)
}


function setStatus(text, ok = true) {
  const el = $('#status')
  el.textContent = text
  el.style.color = ok ? 'var(--muted)' : 'var(--danger)'
}

async function loadIcons() {
  const res = await fetch('./icons.json', { cache: 'no-cache' })
  state.icons = await res.json()

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

  document.querySelectorAll('.icon[data-icon]').forEach((el) => {
    const id = el.getAttribute('data-icon')
    const ic = state.icons.icons.find(x => x.id === id)
    if (!ic) return
    const url = state.icons.baseUrl + ic.path
    el.style.webkitMaskImage = `url(${url})`
    el.style.maskImage = `url(${url})`
  })
}

async function fetchResources(type) {
  const res = await fetch(RES_ENDPOINT(type), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`Fetch ${type} failed: ${res.status}`)
  state.resources[type] = await res.json() || {}
}

function normalizeResource(type, id, obj) {
  const item = { type, id, raw: obj }
  item.name = obj.name || obj.title || id
  item.description = obj.description || obj.note || ''
  item.icon = (obj.properties && obj.properties.icon) || obj.icon || ''
  item.updated = obj.timestamp || obj.updated || obj.modified || obj.created || null

  if (type === 'waypoints') {
    item.position = obj.position || (obj.feature?.geometry?.type === 'Point'
        ? { latitude: obj.feature.geometry.coordinates[1], longitude: obj.feature.geometry.coordinates[0] }
        : null)
  }
  return item
}

function computeDerived(item) {
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

function getItemsForTab() {
  const tab = state.tab
  const r = state.resources[tab] || {}
  return Object.entries(r).map(([id, obj]) => normalizeResource(tab, id, obj))
}

function applyFilters(list) {
  const q = ($('#filterText').value || '').trim().toLowerCase()
  const within = parseFloat($('#filterWithinNm').value || '')
  const icon = ($('#filterIcon').value || '').trim()

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

function applySort(list) {
  const key = $('#sortBy').value
  const order = $('#sortOrder').value
  const dir = order === 'asc' ? 1 : -1
  const getv = (it) => {
    if (key === 'name') return (it.name || '').toLowerCase()
    if (key === 'distance') return it.distanceNm ?? Number.POSITIVE_INFINITY
    if (key === 'bearing') return it.bearing ?? Number.POSITIVE_INFINITY
    if (key === 'updated') return it.updated ? new Date(it.updated).getTime() : 0
    return it.name
  }
  return [...list].sort((a, b) => (getv(a) < getv(b) ? -1 : getv(a) > getv(b) ? 1 : 0) * dir)
}

function renderIconCell(iconId) {
  const wrap = document.createElement('span')
  wrap.className = 'imgicon'
  const ic = (state.icons?.icons || []).find(x => x.id === iconId)
  if (!ic) { wrap.textContent = '—'; wrap.classList.add('muted'); return wrap }
  const img = document.createElement('img')
  img.src = state.icons.baseUrl + ic.path
  img.alt = ic.label
  img.style.filter = 'invert(1)'
  wrap.appendChild(img)
  return wrap
}

function btnTiny(iconId, label, onClick) {
  const b = document.createElement('button')
  b.className = 'btn btn--tiny'
  b.type = 'button'
  b.innerHTML = `<span class="icon" data-icon="${iconId}"></span>`
  b.addEventListener('click', onClick)
  const ic = state.icons.icons.find(x => x.id === iconId)
  if (ic) {
    const url = state.icons.baseUrl + ic.path
    const el = b.querySelector('.icon')
    el.style.webkitMaskImage = `url(${url})`
    el.style.maskImage = `url(${url})`
  }
  return b
}

function renderActions(it) {
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

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function render() {
  const isFiles = state.tab === 'files'
  setHidden($('#filesView'), !isFiles)
  setHidden($('#tableWrap'), isFiles)
  setHidden($('#filtersPanel'), isFiles)
  if (isFiles) {
    $('#listTitle').textContent = 'Files'
    $('#listMeta').textContent = ''
    renderFiles()
    return
  }

  $('#listTitle').textContent = state.tab[0].toUpperCase() + state.tab.slice(1)
  let list = getItemsForTab().map(it => {
    if (state.tab === 'waypoints') computeDerived(it)
    return it
  })
  list = applyFilters(list)
  list = applySort(list)
  state.list = list

  $('#listMeta').textContent = `${list.length} item(s) • selected: ${state.selected.size}`

  const tbody = $('#tbody')
  tbody.innerHTML = ''
  for (const it of list) {
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

    tbody.appendChild(tr)
  }
}

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

  const updated = JSON.parse(JSON.stringify(orig))
  updated.name = name
  updated.description = description
  updated.position = { latitude: lat, longitude: lon }
  updated.properties = updated.properties || {}
  if (icon) updated.properties.icon = icon
  else delete updated.properties.icon

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

async function createAtVesselPosition() {
  if (!state.vesselPos) { setStatus('No vessel position available', false); return }
  const name = `WP ${new Date().toISOString().slice(11,19)}`
  const wp = { name, description: 'Created from Navigation Manager', position: { ...state.vesselPos }, properties: { icon: 'waypoint' } }
  try {
    setStatus('Creating…')
    const res = await fetch(RES_ENDPOINT('waypoints'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wp) })
    if (!res.ok) throw new Error(`Create failed: ${res.status}`)
    await refresh()
    setStatus('Created ✔', true)
  } catch (e) { setStatus(e.message || String(e), false) }
}

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
  setStatus('Exported ✔', true)
}

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

    const creates = items.filter(x => x.kind === 'waypoint').map(it => ({
      name: it.name || 'Waypoint',
      description: it.description || '',
      position: { latitude: it.latitude, longitude: it.longitude },
      properties: { icon: it.icon || 'waypoint' }
    }))
    if (!creates.length) throw new Error('No importable waypoints found')

    setStatus(`Importing ${creates.length} waypoint(s)…`)
    for (const c of creates) {
      const res = await fetch(RES_ENDPOINT('waypoints'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) })
      if (!res.ok) throw new Error(`Create failed: ${res.status}`)
    }
    await refresh()
    setStatus('Imported ✔', true)
  } catch (e) { setStatus(e.message || String(e), false) }
  finally { $('#importFile').value = '' }
}

function setTab(tab) {
  state.tab = tab
  state.selected.clear()
  document.querySelectorAll('.segmented__btn').forEach(b => b.classList.toggle('segmented__btn--active', b.dataset.tab === tab))
  render()
}

function setSelectAll(on) {
  const list = getItemsForTab()
  if (on) for (const it of list) state.selected.add(`${it.type}:${it.id}`)
  else state.selected.clear()
  render()
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/signalk/v1/stream?subscribe=none`
  const ws = new WebSocket(url)
  ws.onopen = () => {
    setStatus('Live connected', true)
    ws.send(JSON.stringify({ context:'vessels.self', subscribe:[{ path:'navigation.position', period:1000 }] }))
  }
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data)
      for (const up of (data.updates || [])) {
        for (const v of (up.values || [])) {
          if (v.path === 'navigation.position' && v.value?.latitude != null) state.vesselPos = v.value
        }
      }
      if (state.tab === 'waypoints') render()
    } catch {}
  }
  ws.onclose = () => { setStatus('Live disconnected (retrying)…', false); setTimeout(connectWS, 2000) }
}

function wire() {
  document.querySelectorAll('.segmented__btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $('#btnRefresh').addEventListener('click', refresh)
  ;['filterText','filterWithinNm','filterIcon','sortBy','sortOrder'].forEach(id => {
    $(`#${id}`).addEventListener('input', render)
    $(`#${id}`).addEventListener('change', render)
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
  $('#localPick')?.addEventListener('change', (e) => { filesState.localFiles = Array.from(e.target.files || []); renderFiles() })
  $('#btnLocalClear')?.addEventListener('click', () => { filesState.localFiles = []; renderFiles() })

  $('#doExport').addEventListener('click', (e) => { e.preventDefault(); doExport(); $('#dlgExport').close() })
  $('#doImport').addEventListener('click', (e) => { e.preventDefault(); doImport(); $('#dlgImport').close() })
  $('#doSave').addEventListener('click', (e) => { e.preventDefault(); saveWaypoint(); $('#dlgEdit').close() })
}

async function boot() {
  await loadIcons()
  wire()
  await refresh()
  try { await remoteList('') } catch {}
  connectWS()
}
boot().catch(e => setStatus(e.message || String(e), false))
