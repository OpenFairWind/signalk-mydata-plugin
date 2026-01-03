export function fmt(n, digits=2) {
  if (n == null || Number.isNaN(n)) return '—'
  return Number(n).toFixed(digits)
}
export function haversineNm(lat1, lon1, lat2, lon2) {
  const Rm = 6371000
  const toRad = (d) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  return (Rm * c) / 1852
}
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180
  const toDeg = (r) => r * 180 / Math.PI
  const φ1 = toRad(lat1), φ2 = toRad(lat2)
  const Δλ = toRad(lon2 - lon1)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/octet-stream' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(a.href)
}
export function toCSV(rows) {
  const cols = Object.keys(rows[0] || {name:'',latitude:'',longitude:'',description:'',icon:''})
  const esc = (v) => {
    const s = (v ?? '').toString()
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`
    return s
  }
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')
}
export function parseCSV(text) {
  const lines = text.replace(/\r/g,'').split('\n').filter(l => l.trim().length)
  if (!lines.length) return []
  const header = parseCSVLine(lines[0])
  const items = []
  for (let i=1;i<lines.length;i++){
    const row = parseCSVLine(lines[i])
    const obj = {}
    header.forEach((h, idx) => obj[h] = row[idx] ?? '')
    const lat = parseFloat(obj.latitude ?? obj.lat)
    const lon = parseFloat(obj.longitude ?? obj.lon)
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      items.push({ kind:'waypoint', name: obj.name||'Waypoint', description: obj.description||'', latitude:lat, longitude:lon, icon: obj.icon||'' })
    }
  }
  return items
}
function parseCSVLine(line){
  const out=[]; let cur='', inQ=false
  for (let i=0;i<line.length;i++){
    const ch=line[i]
    if (inQ){
      if (ch === '"' && line[i+1] === '"'){ cur+='"'; i++; continue }
      if (ch === '"'){ inQ=false; continue }
      cur+=ch
    } else {
      if (ch === '"'){ inQ=true; continue }
      if (ch === ','){ out.push(cur); cur=''; continue }
      cur+=ch
    }
  }
  out.push(cur)
  return out.map(s => s.trim())
}
export function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const items = []
  for (const w of [...doc.querySelectorAll('wpt')]) {
    const lat = parseFloat(w.getAttribute('lat'))
    const lon = parseFloat(w.getAttribute('lon'))
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue
    items.push({ kind:'waypoint', name: w.querySelector('name')?.textContent?.trim() || 'Waypoint', description: w.querySelector('desc')?.textContent?.trim() || '', latitude:lat, longitude:lon, icon: w.querySelector('sym')?.textContent?.trim() || '' })
  }
  for (const r of [...doc.querySelectorAll('rte')]) {
    const name = r.querySelector('name')?.textContent?.trim() || 'Route'
    const desc = r.querySelector('desc')?.textContent?.trim() || ''
    const pts = [...r.querySelectorAll('rtept')].map(p => ({ latitude: parseFloat(p.getAttribute('lat')), longitude: parseFloat(p.getAttribute('lon')) }))
      .filter(p => !Number.isNaN(p.latitude) && !Number.isNaN(p.longitude))
    if (pts.length) items.push({ kind:'route', name, description:desc, points: pts })
  }
  for (const t of [...doc.querySelectorAll('trk')]) {
    const name = t.querySelector('name')?.textContent?.trim() || 'Track'
    const desc = t.querySelector('desc')?.textContent?.trim() || ''
    const pts = [...t.querySelectorAll('trkpt')].map(p => ({ latitude: parseFloat(p.getAttribute('lat')), longitude: parseFloat(p.getAttribute('lon')) }))
      .filter(p => !Number.isNaN(p.latitude) && !Number.isNaN(p.longitude))
    if (pts.length) items.push({ kind:'track', name, description:desc, points: pts })
  }
  return items
}
export function toGPX({ waypoints = [] }) {
  const esc = (s) => (s ?? '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const wptXml = waypoints.map(w => `
    <wpt lat="${w.latitude}" lon="${w.longitude}">
      <name>${esc(w.name || 'Waypoint')}</name>
      ${w.description ? `<desc>${esc(w.description)}</desc>` : ''}
      ${w.icon ? `<sym>${esc(w.icon)}</sym>` : ''}
    </wpt>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Navigation Manager" xmlns="http://www.topografix.com/GPX/1/1">
${wptXml}
</gpx>`
}
export function parseKML(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const items = []
  for (const pm of [...doc.querySelectorAll('Placemark')]) {
    const name = pm.querySelector('name')?.textContent?.trim() || 'Item'
    const desc = pm.querySelector('description')?.textContent?.trim() || ''
    const point = pm.querySelector('Point coordinates')?.textContent?.trim()
    const line = pm.querySelector('LineString coordinates')?.textContent?.trim()
    if (point) {
      const [lon, lat] = point.split(',').map(x => parseFloat(x))
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) items.push({ kind:'waypoint', name, description:desc, latitude:lat, longitude:lon, icon:'' })
    } else if (line) {
      const coords = line.split(/\s+/).map(s => s.trim()).filter(Boolean).map(s => {
        const [lon, lat] = s.split(',').map(x => parseFloat(x))
        return { latitude: lat, longitude: lon }
      }).filter(p => !Number.isNaN(p.latitude) && !Number.isNaN(p.longitude))
      if (coords.length) items.push({ kind:'track', name, description:desc, points: coords })
    }
  }
  return items
}
export function toKML({ waypoints = [] }) {
  const esc = (s) => (s ?? '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const wpt = waypoints.map(w => `
  <Placemark>
    <name>${esc(w.name || 'Waypoint')}</name>
    ${w.description ? `<description>${esc(w.description)}</description>` : ''}
    <Point><coordinates>${w.longitude},${w.latitude},0</coordinates></Point>
  </Placemark>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Navigation Manager Export</name>
  ${wpt}
</Document>
</kml>`
}

// ---------------- GeoJSON ----------------
//
// Supports Feature or FeatureCollection.
// Waypoints: Point geometry
// Routes/Tracks: LineString or MultiLineString (flattened)
// Disambiguation: feature.properties.kind ('waypoint'|'route'|'track') preferred;
// otherwise geometry Point->waypoint, LineString->track.
export function parseGeoJSON(text) {
  const obj = JSON.parse(text)
  const feats = []
  if (obj && obj.type === 'FeatureCollection' && Array.isArray(obj.features)) feats.push(...obj.features)
  else if (obj && obj.type === 'Feature') feats.push(obj)
  else throw new Error('GeoJSON must be a Feature or FeatureCollection')

  const items = []

  const addLine = (kind, name, description, coords) => {
    const pts = (coords || []).map(c => ({ longitude: c[0], latitude: c[1] }))
      .filter(p => p.latitude != null && p.longitude != null && !Number.isNaN(p.latitude) && !Number.isNaN(p.longitude))
      .map(p => ({ latitude: p.latitude, longitude: p.longitude }))
    if (pts.length) items.push({ kind, name, description, points: pts })
  }

  for (const f of feats) {
    if (!f || f.type !== 'Feature' || !f.geometry) continue
    const g = f.geometry
    const p = f.properties || {}
    const name = (p.name || p.title || 'Item').toString()
    const description = (p.description || p.desc || '').toString()
    const kindProp = (p.kind || p.type || '').toString().toLowerCase()
    const kindFromGeom = g.type === 'Point' ? 'waypoint' : (g.type === 'LineString' || g.type === 'MultiLineString') ? 'track' : ''
    const kind = (kindProp === 'route' || kindProp === 'track' || kindProp === 'waypoint') ? kindProp : kindFromGeom

    if (g.type === 'Point') {
      const c = g.coordinates
      if (!Array.isArray(c) || c.length < 2) continue
      const lon = Number(c[0]), lat = Number(c[1])
      if (Number.isNaN(lat) || Number.isNaN(lon)) continue
      items.push({
        kind: 'waypoint',
        name,
        description,
        latitude: lat,
        longitude: lon,
        icon: (p.icon || p.sym || '')?.toString() || ''
      })
    } else if (g.type === 'LineString') {
      addLine(kind === 'route' ? 'route' : 'track', name, description, g.coordinates)
    } else if (g.type === 'MultiLineString') {
      const merged = []
      for (const part of (g.coordinates || [])) {
        if (Array.isArray(part)) merged.push(...part)
      }
      addLine(kind === 'route' ? 'route' : 'track', name, description, merged)
    }
  }
  return items
}

export function toGeoJSON({ waypoints = [], routes = [], tracks = [] }) {
  const features = []

  for (const w of (waypoints || [])) {
    if (w.latitude == null || w.longitude == null) continue
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(w.longitude), Number(w.latitude)] },
      properties: {
        kind: 'waypoint',
        id: w.id || null,
        name: w.name || 'Waypoint',
        description: w.description || '',
        icon: w.icon || ''
      }
    })
  }

  const lineFeature = (kind, o) => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: (o.points || []).map(p => [Number(p.longitude), Number(p.latitude)])
    },
    properties: {
      kind,
      id: o.id || null,
      name: o.name || (kind === 'route' ? 'Route' : 'Track'),
      description: o.description || ''
    }
  })

  for (const r of (routes || [])) {
    if (!r.points?.length) continue
    features.push(lineFeature('route', r))
  }
  for (const t of (tracks || [])) {
    if (!t.points?.length) continue
    features.push(lineFeature('track', t))
  }

  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2)
}
