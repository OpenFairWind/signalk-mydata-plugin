// Format a number with a fallback glyph when undefined.
export function fmt(n, digits=2) {
  if (n == null || Number.isNaN(n)) return '—' // Dash placeholder for missing values.
  return Number(n).toFixed(digits) // Fixed decimal formatting.
}
// Compute great-circle distance in nautical miles using the haversine formula.
export function haversineNm(lat1, lon1, lat2, lon2) {
  const Rm = 6371000 // Earth radius in meters.
  const toRad = (d) => d * Math.PI / 180 // Degrees-to-radians helper.
  const dLat = toRad(lat2 - lat1) // Latitude delta in radians.
  const dLon = toRad(lon2 - lon1) // Longitude delta in radians.
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2 // Haversine component.
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) // Angular distance.
  return (Rm * c) / 1852 // Convert meters to nautical miles.
}
// Calculate initial bearing from point A to B in degrees.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180 // Degrees-to-radians helper.
  const toDeg = (r) => r * 180 / Math.PI // Radians-to-degrees helper.
  const φ1 = toRad(lat1), φ2 = toRad(lat2) // Latitudes in radians.
  const Δλ = toRad(lon2 - lon1) // Longitude delta.
  const y = Math.sin(Δλ) * Math.cos(φ2) // Bearing numerator.
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ) // Bearing denominator.
  return (toDeg(Math.atan2(y, x)) + 360) % 360 // Normalized 0-359 bearing.
}
// Trigger a client-side download for the provided text content.
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/octet-stream' }) // Wrap text in a Blob.
  const a = document.createElement('a') // Create anchor tag.
  a.href = URL.createObjectURL(blob) // Attach blob URL.
  a.download = filename // Set download filename.
  document.body.appendChild(a) // Insert into DOM to allow click.
  a.click() // Trigger download.
  a.remove() // Clean up anchor.
  URL.revokeObjectURL(a.href) // Revoke object URL.
}
// Serialize an array of objects into CSV text.
export function toCSV(rows) {
  const cols = Object.keys(rows[0] || {name:'',latitude:'',longitude:'',description:'',icon:''}) // Column order.
  const esc = (v) => {
    const s = (v ?? '').toString() // Normalize undefined/null to string.
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g,'""')}"` // Escape quotes and wrap when needed.
    return s // Return as-is for simple values.
  }
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') // Compose CSV lines.
}
// Parse a CSV file into waypoint objects.
export function parseCSV(text) {
  const lines = text.replace(/\r/g,'').split('\n').filter(l => l.trim().length) // Normalize newlines and drop blanks.
  if (!lines.length) return [] // Empty input yields no items.
  const header = parseCSVLine(lines[0]) // Extract header columns.
  const items = [] // Output accumulator.
  for (let i=1;i<lines.length;i++){ // Iterate data lines.
    const row = parseCSVLine(lines[i]) // Parse each CSV line.
    const obj = {} // Temporary row object.
    header.forEach((h, idx) => obj[h] = row[idx] ?? '') // Map fields by header name.
    const lat = parseFloat(obj.latitude ?? obj.lat) // Latitude column variant.
    const lon = parseFloat(obj.longitude ?? obj.lon) // Longitude column variant.
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      items.push({ kind:'waypoint', name: obj.name||'Waypoint', description: obj.description||'', latitude:lat, longitude:lon, icon: obj.icon||'' }) // Build waypoint record.
    }
  }
  return items // Return parsed waypoints.
}
// Parse a single CSV row supporting quoted fields.
function parseCSVLine(line){
  const out=[]; let cur='', inQ=false // Output array, current field buffer, quote flag.
  for (let i=0;i<line.length;i++){
    const ch=line[i] // Current character.
    if (inQ){
      if (ch === '"' && line[i+1] === '"'){ cur+='"'; i++; continue } // Escaped quote.
      if (ch === '"'){ inQ=false; continue } // Closing quote.
      cur+=ch // Regular character inside quotes.
    } else {
      if (ch === '"'){ inQ=true; continue } // Opening quote.
      if (ch === ','){ out.push(cur); cur=''; continue } // Field separator.
      cur+=ch // Regular character.
    }
  }
  out.push(cur) // Push final field.
  return out.map(s => s.trim()) // Trim whitespace around fields.
}
// Parse GPX XML into waypoint/route/track records.
export function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml') // Build DOM document.
  const items = [] // Aggregate result.
  for (const w of [...doc.querySelectorAll('wpt')]) { // Waypoints.
    const lat = parseFloat(w.getAttribute('lat')) // Latitude attribute.
    const lon = parseFloat(w.getAttribute('lon')) // Longitude attribute.
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue // Skip invalid entries.
    items.push({ kind:'waypoint', name: w.querySelector('name')?.textContent?.trim() || 'Waypoint', description: w.querySelector('desc')?.textContent?.trim() || '', latitude:lat, longitude:lon, icon: w.querySelector('sym')?.textContent?.trim() || '' }) // Push waypoint.
  }
  for (const r of [...doc.querySelectorAll('rte')]) { // Routes.
    const name = r.querySelector('name')?.textContent?.trim() || 'Route' // Route name.
    const desc = r.querySelector('desc')?.textContent?.trim() || '' // Route description.
    const pts = [...r.querySelectorAll('rtept')].map(p => ({ latitude: parseFloat(p.getAttribute('lat')), longitude: parseFloat(p.getAttribute('lon')) }))
        .filter(p => !Number.isNaN(p.latitude) && !Number.isNaN(p.longitude)) // Validate coordinates.
    if (pts.length) items.push({ kind:'route', name, description:desc, points: pts }) // Push route when points exist.
  }
  for (const t of [...doc.querySelectorAll('trk')]) { // Tracks.
    const name = t.querySelector('name')?.textContent?.trim() || 'Track' // Track name.
    const desc = t.querySelector('desc')?.textContent?.trim() || '' // Track description.
    const pts = [...t.querySelectorAll('trkpt')].map(p => ({ latitude: parseFloat(p.getAttribute('lat')), longitude: parseFloat(p.getAttribute('lon')) }))
        .filter(p => !Number.isNaN(p.latitude) && !Number.isNaN(p.longitude)) // Validate points.
    if (pts.length) items.push({ kind:'track', name, description:desc, points: pts }) // Push track with points.
  }
  return items // Return collected records.
}
// Serialize waypoints to a minimal GPX document.
export function toGPX({ waypoints = [] }) {
  const esc = (s) => (s ?? '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') // XML escape helper.
  const wptXml = waypoints.map(w => `
    <wpt lat="${w.latitude}" lon="${w.longitude}">
      <name>${esc(w.name || 'Waypoint')}</name>
      ${w.description ? `<desc>${esc(w.description)}</desc>` : ''}
      ${w.icon ? `<sym>${esc(w.icon)}</sym>` : ''}
    </wpt>`).join('\n') // Join waypoint snippets.
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Navigation Manager" xmlns="http://www.topografix.com/GPX/1/1">
${wptXml}
</gpx>` // Envelope GPX.
}
// Parse KML into waypoints or tracks.
export function parseKML(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml') // Build KML DOM.
  const items = [] // Output list.
  for (const pm of [...doc.querySelectorAll('Placemark')]) { // Every Placemark.
    const name = pm.querySelector('name')?.textContent?.trim() || 'Item' // Placemark name.
    const desc = pm.querySelector('description')?.textContent?.trim() || '' // Placemark description.
    const point = pm.querySelector('Point coordinates')?.textContent?.trim() // Point coordinates string.
    const line = pm.querySelector('LineString coordinates')?.textContent?.trim() // LineString coordinates string.
    if (point) {
      const [lon, lat] = point.split(',').map(x => parseFloat(x)) // Parse lon/lat.
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) items.push({ kind:'waypoint', name, description:desc, latitude:lat, longitude:lon, icon:'' }) // Push waypoint.
    } else if (line) {
      const coords = line.split(/\s+/).map(s => s.trim()).filter(Boolean).map(s => {
        const [lon, lat] = s.split(',').map(x => parseFloat(x)) // Parse lon/lat pair.
        return { latitude: lat, longitude: lon } // Shape into object.
      }).filter(p => !Number.isNaN(p.latitude) && !Number.isNaN(p.longitude)) // Validate entries.
      if (coords.length) items.push({ kind:'track', name, description:desc, points: coords }) // Push track.
    }
  }
  return items // Return parsed items.
}
// Serialize waypoints to KML for export.
export function toKML({ waypoints = [] }) {
  const esc = (s) => (s ?? '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') // XML escape helper.
  const wpt = waypoints.map(w => `
  <Placemark>
    <name>${esc(w.name || 'Waypoint')}</name>
    ${w.description ? `<description>${esc(w.description)}</description>` : ''}
    <Point><coordinates>${w.longitude},${w.latitude},0</coordinates></Point>
  </Placemark>`).join('\n') // Join waypoint placemarks.
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Navigation Manager Export</name>
  ${wpt}
</Document>
</kml>` // Complete KML document.
}

// ---------------- GeoJSON ----------------
//
// Supports Feature or FeatureCollection.
// Waypoints: Point geometry
// Routes/Tracks: LineString or MultiLineString (flattened)
// Disambiguation: feature.properties.kind ('waypoint'|'route'|'track') preferred;
// otherwise geometry Point->waypoint, LineString->track.
export function parseGeoJSON(text) {
  const obj = JSON.parse(text) // Parse JSON input.
  const feats = [] // Collection of features to process.
  if (obj && obj.type === 'FeatureCollection' && Array.isArray(obj.features)) feats.push(...obj.features) // Expand collection features.
  else if (obj && obj.type === 'Feature') feats.push(obj) // Wrap single feature.
  else throw new Error('GeoJSON must be a Feature or FeatureCollection') // Guard invalid inputs.

  const items = [] // Output array.
  const pickFirst = (...vals) => {
    for (const v of vals) if (v !== undefined && v !== null && v !== '') return v
    return null
  }
  const toText = (v, fallback='') => {
    if (v === undefined || v === null) return fallback
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number' || typeof v === 'boolean') return v.toString()
    if (Array.isArray(v)) return v.join(', ')
    try { return v.toString() } catch { return fallback }
  }

  // Helper to flatten line-based geometries into route/track items.
  const addLine = (kind, name, description, coords) => {
    const pts = (coords || []).map(c => ({ longitude: c[0], latitude: c[1] }))
        .filter(p => p.latitude != null && p.longitude != null && !Number.isNaN(p.latitude) && !Number.isNaN(p.longitude))
        .map(p => ({ latitude: p.latitude, longitude: p.longitude }))
    if (pts.length) items.push({ kind, name, description, points: pts })
  }

  for (const f of feats) {
    if (!f || f.type !== 'Feature' || !f.geometry) continue // Skip invalid features.
    const g = f.geometry // Geometry reference.
    const p = { ...(f.properties || {}) } // Properties map.
    const nameProp = p.name ?? p.title ?? f.name ?? f.id ?? 'Waypoint'
    const descProp = p.description ?? p.desc ?? p.note ?? f.description ?? ''
    const name = toText(nameProp, 'Waypoint') // Preferred name.
    const description = toText(descProp, '') // Preferred description.
    const typeProp = p.type
    const skIcon = p.skIcon || p.skicon || ''
    delete p.name; delete p.description; delete p.type
    const kindProp = (p.kind || typeProp || '').toString().toLowerCase() // Explicit kind property.
    const kindFromGeom = g.type === 'Point' ? 'waypoint' : (g.type === 'LineString' || g.type === 'MultiLineString') ? 'track' : '' // Infer kind.
    const kind = (kindProp === 'route' || kindProp === 'track' || kindProp === 'waypoint') ? kindProp : kindFromGeom // Decide kind.

    if (g.type === 'Point') {
      const c = g.coordinates // Point coordinates.
      if (!Array.isArray(c) || c.length < 2) continue // Validate.
      const lon = Number(c[0]), lat = Number(c[1]) // Numeric coordinates.
      if (Number.isNaN(lat) || Number.isNaN(lon)) continue // Skip invalid.
      items.push({
        kind: 'waypoint',
        name,
        description,
        latitude: lat,
        longitude: lon,
        type: typeProp || '',
        skIcon: skIcon || '',
        properties: p,
        icon: (p.icon || p.sym || '')?.toString() || ''
      }) // Push waypoint.
    } else if (g.type === 'LineString') {
      addLine(kind === 'route' ? 'route' : 'track', name, description, g.coordinates) // Single line.
    } else if (g.type === 'MultiLineString') {
      const merged = [] // Container for merged coordinates.
      for (const part of (g.coordinates || [])) {
        if (Array.isArray(part)) merged.push(...part) // Flatten each part.
      }
      addLine(kind === 'route' ? 'route' : 'track', name, description, merged) // Add merged line.
    }
  }
  return items // Return results.
}

export function toGeoJSON({ waypoints = [], routes = [], tracks = [] }) {
  const features = [] // Output feature list.

  for (const w of (waypoints || [])) {
    if (w.latitude == null || w.longitude == null) continue // Skip incomplete points.
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(w.longitude), Number(w.latitude)] }, // Point geometry.
      properties: {
        kind: 'waypoint',
        id: w.id || null,
        name: w.name || 'Waypoint',
        description: w.description || '',
        type: w.type || '',
        skIcon: w.skIcon || '',
        icon: w.icon || ''
      }
    })
  }

  // Helper to build a line feature for routes/tracks.
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
    if (!r.points?.length) continue // Ignore empty routes.
    features.push(lineFeature('route', r)) // Add route feature.
  }
  for (const t of (tracks || [])) {
    if (!t.points?.length) continue // Ignore empty tracks.
    features.push(lineFeature('track', t)) // Add track feature.
  }

  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2) // Stringify with indentation.
}
