/*
 * Signal K Node Server plugin: signalk-mydata-plugin
 *
 * - Serves a dependency-free webapp at /plugins/signalk-mydata-plugin
 * - Exposes helpers for goto/show actions and remote file CRUD endpoints
 * - Uses the Signal K v2 Resources API for waypoints/routes/tracks
 *
 * Notes:
 * - Authentication/authorization are delegated to the Signal K server.
 */
const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const Busboy = require('busboy')
const { spawn } = require('child_process')
module.exports = function (app) {
  // Logger helper that defers to Signal K debug/error when available.
  const logError =
      app.error ||
      (err => {
        console.error(err)
      })
  const debug =
      app.debug ||
      (msg => {
        console.log(msg)
      })

  // Plugin instance scaffold with lifecycle callbacks.
  var plugin = {
    unsubscribes: []
  }

  // Plugin identifiers exposed to Signal K.
  plugin.id = "signalk-mydata-plugin"
  plugin.name = 'MyData (Waypoints/Routes/Files)'
  plugin.description = 'A web application to manage waypoints, tracks, and files.'

  // JSON schema for configuration shown in the Signal K UI.
  plugin.schema = () => ({
    title: 'Manage my data',
    type: 'object',
    properties: {
      remoteFileRoot: {
        type: 'string',
        title: 'Remote files root directory',
        description: 'Files panel browses/uploads/downloads files under this server-side directory. Use an absolute path. Path traversal is blocked.',
        default: '/var/lib/signalk/mydata-files'
      },
      additionalFileRoots: {
        type: 'array',
        title: 'Additional file root directories',
        description: 'Optional extra root folders for the Files tab. Each entry needs a label and an absolute path.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', title: 'Label' },
            path: { type: 'string', title: 'Path' }
          }
        },
        default: []
      },
      coordinateFormat: {
        type: 'string',
        title: 'Geographic coordinates format',
        description: 'Controls how latitude/longitude are rendered in the waypoint detail.',
        enum: ['dd', 'dm', 'dms'],
        enumNames: ['Degrees + decimal', 'Degrees + minutes (decimal)', 'Degrees + minutes + seconds'],
        default: 'dd'
      },
      distanceUnit: {
        type: 'string',
        title: 'Distance unit',
        enum: ['nm', 'km'],
        enumNames: ['Nautical miles', 'Kilometers'],
        default: 'nm'
      },
      depthUnit: {
        type: 'string',
        title: 'Depth unit',
        enum: ['m', 'ft', 'fathom'],
        enumNames: ['Meters', 'Feet', 'Fathoms'],
        default: 'm'
      },
      waypointPropertyViews: {
        type: 'array',
        title: 'Waypoint property rendering',
        description: 'Configure which feature.properties fields should render as custom rows.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', title: 'Property path (dot notation)' },
            paths: {
              type: 'array',
              title: 'Grouped property paths (dot notation)',
              description: 'Render multiple properties on a single line in the waypoint detail view.',
              items: { type: 'string' }
            },
            label: { type: 'string', title: 'Label' },
            labels: {
              type: 'array',
              title: 'Grouped labels',
              description: 'Optional labels aligned with grouped paths.',
              items: { type: 'string' }
            },
            mode: {
              type: 'string',
              title: 'Render mode',
              enum: ['tree', 'single-line', 'text', 'number', 'icon', 'icon-text', 'array', 'three-view'],
              enumNames: ['Tree view', 'Single line', 'Text', 'Number', 'Icon', 'Icon with text', 'Array', 'Three view'],
              default: 'single-line'
            }
          }
        },
        default: []
      },
      interval: {
        type: 'number',
        title: 'Interval',
        default: 0
      }
    }
  })

  // Expose a status message for the plugin card.
  let lastMessage = ''
  plugin.statusMessage = function () {
    return `${lastMessage}`
  }

  // Start hook invoked by Signal K when enabling the plugin.
  plugin.start = function (options) {
    // Resolve configured remote file root (with default).
    const remoteRoot = (options && options.remoteFileRoot) ? options.remoteFileRoot : '/var/lib/signalk/mydata-files'
    const extraRoots = (options && Array.isArray(options.additionalFileRoots)) ? options.additionalFileRoots : []
    const fileRoots = [
      { id: 'default', label: 'Default', path: remoteRoot },
      ...extraRoots
        .filter(root => root && root.path)
        .map((root, idx) => ({
          id: `extra-${idx + 1}`,
          label: root.label || root.path,
          path: root.path
        }))
    ]

    // Router registration used by Signal K to mount HTTP handlers.
    plugin.registerWithRouter = (router) => {

      // Known text extensions for inline preview.
      const TEXT_EXTS = ['.txt','.log','.md','.json','.geojson','.gpx','.kml','.csv','.xml','.yaml','.yml']
      // Map of extensions to MIME types for accurate previews and downloads.
      const MIME_MAP = {
        '.txt': 'text/plain',
        '.log': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.geojson': 'application/geo+json',
        '.gpx': 'application/gpx+xml',
        '.kml': 'application/vnd.google-earth.kml+xml',
        '.csv': 'text/csv',
        '.xml': 'application/xml',
        '.yaml': 'application/yaml',
        '.yml': 'application/yaml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm'
      }

      // Safely join a root directory with a relative path while blocking traversal.
      function safeJoin(root, rel) {
        const r = (rel || '').replace(/\\/g, '/')
        const cleaned = r.replace(/^\/+/, '') // force relative
        const full = path.resolve(root, cleaned)
        const rootFull = path.resolve(root)
        if (!full.startsWith(rootFull + path.sep) && full !== rootFull) {
          throw new Error('Path traversal blocked')
        }
        return full
      }

      function resolveRoot(rootId) {
        if (!rootId) return fileRoots[0]
        return fileRoots.find(root => root.id === rootId) || fileRoots[0]
      }

      // Ensure a directory exists before writing into it.
      async function ensureDir(p) {
        await fsp.mkdir(p, { recursive: true })
      }

      // Convert a filesystem stat result to a lightweight file entry object.
      function statToEntry(name, st) {
        return {
          name,
          type: st.isDirectory() ? 'dir' : 'file',
          size: st.isDirectory() ? null : st.size,
          mtime: st.mtime ? st.mtime.toISOString() : null
        }
      }

      // List files inside a directory relative to the configured root.
      router.get(`/files/list`, async (req, res) => {
        try {
          const rel = req.query.path || ''
          const root = resolveRoot(req.query.root)
          const dir = safeJoin(root.path, rel)
          await ensureDir(dir)
          const entries = []
          const names = await fsp.readdir(dir)
          for (const name of names) {
            const st = await fsp.stat(path.join(dir, name))
            entries.push(statToEntry(name, st))
          }
          entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)))
          res.json({ ok: true, path: rel, entries, root: root.id })
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      router.get(`/config`, (req, res) => {
        res.json({
          ok: true,
          config: {
            coordinateFormat: options?.coordinateFormat || 'dd',
            distanceUnit: options?.distanceUnit || 'nm',
            depthUnit: options?.depthUnit || 'm',
            waypointPropertyViews: Array.isArray(options?.waypointPropertyViews) ? options.waypointPropertyViews : [],
            fileRoots: fileRoots.map(root => ({ id: root.id, label: root.label, path: root.path }))
          }
        })
      })

      // Read file contents for inline preview (text, images, limited size).
      router.get(`/files/read`, async (req, res) => {
        try {
          const rel = req.query.path
          if (!rel) return res.status(400).json({ ok: false, error: 'Missing path' })
          const root = resolveRoot(req.query.root)
          const full = safeJoin(root.path, rel)
          const st = await fsp.stat(full)
          if (!st.isFile()) return res.status(400).json({ ok: false, error: 'Not a file' })
          if (st.size > 5 * 1024 * 1024) {
            return res.status(413).json({ ok: false, error: 'File too large for inline preview (use download)' })
          }
          const buf = await fsp.readFile(full)
          const ext = path.extname(full).toLowerCase()
          const mime = MIME_MAP[ext] || 'application/octet-stream'
          const isText = TEXT_EXTS.includes(ext)
          const previewable = (!isText) && (
            mime.startsWith('image/') ||
            mime.startsWith('audio/') ||
            mime.startsWith('video/') ||
            mime === 'application/pdf'
          )
          if (!isText && !previewable) {
            return res.json({ ok: true, kind: 'binary', size: st.size, mime })
          }
          if (previewable) {
            return res.json({ ok: true, kind: 'binary', size: st.size, mime, data: buf.toString('base64'), encoding: 'base64' })
          }
          res.json({ ok: true, kind: 'text', size: st.size, mime, text: buf.toString('utf8') })
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      // Download a file without preview limitations.
      router.get(`/files/download`, async (req, res) => {
        try {
          const rel = req.query.path
          if (!rel) return res.status(400).json({ ok: false, error: 'Missing path' })
          const root = resolveRoot(req.query.root)
          const full = safeJoin(root.path, rel)
          const st = await fsp.stat(full)
          if (st.isDirectory()) {
            const base = path.basename(full) || 'directory'
            res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`)
            res.setHeader('Content-Type', 'application/zip')
            const zip = spawn('zip', ['-r', '-', base], { cwd: path.dirname(full) })
            zip.stdout.pipe(res)
            zip.stderr.on('data', (d) => debug(`zip: ${d}`))
            res.on('close', () => zip.kill('SIGTERM'))
            zip.on('error', (err) => {
              res.status(500).end(`zip error: ${err.message || err}`)
            })
            zip.on('close', (code) => {
              if (code !== 0 && !res.headersSent) res.status(500).end(`zip exited ${code}`)
            })
          } else if (st.isFile()) {
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(full)}"`)
            res.setHeader('Content-Type', 'application/octet-stream')
            fs.createReadStream(full).pipe(res)
          } else {
            res.status(400).json({ ok: false, error: 'Not a file or directory' })
          }
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      // Create a new directory.
      router.post(`/files/mkdir`, async (req, res) => {
        try {
          const rel = req.body && req.body.path
          if (!rel) return res.status(400).json({ ok: false, error: 'Missing path' })
          const root = resolveRoot(req.body?.root)
          const full = safeJoin(root.path, rel)
          await ensureDir(full)
          res.json({ ok: true })
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      // Upload one or more files to the current directory.
      router.post(`/files/upload`, (req, res) => {
        const bb = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } })
        let dirRel = ''
        let saved = []

        bb.on('field', (name, val) => {
          if (name === 'dir') dirRel = val || ''
          if (name === 'root') req.rootId = val
        })

        bb.on('file', (name, file, info) => {
          const filename = info.filename || 'upload.bin'
          try {
            const root = resolveRoot(req.rootId)
            const dirFull = safeJoin(root.path, dirRel)
            ensureDir(dirFull).then(() => {
              const outPath = path.join(dirFull, path.basename(filename))
              saved.push({ path: path.posix.join(dirRel.replace(/\\/g,'/'), path.basename(filename)) })
              const ws = fs.createWriteStream(outPath)
              file.pipe(ws)
            }).catch(() => file.resume())
          } catch (e) {
            file.resume()
          }
        })

        bb.on('error', (e) => res.status(400).json({ ok: false, error: e.message || String(e) }))
        bb.on('finish', () => res.json({ ok: true, saved }))
        req.pipe(bb)
      })

      // Write a file (text or base64 payload) for create/edit operations.
      router.post(`/files/write`, async (req, res) => {
        try {
          const rel = req.body && req.body.path
          const content = req.body && req.body.content
          const encoding = req.body && req.body.encoding
          if (!rel) return res.status(400).json({ ok: false, error: 'Missing path' })
          if (typeof content !== 'string') return res.status(400).json({ ok: false, error: 'Missing content' })
          const root = resolveRoot(req.body?.root)
          const full = safeJoin(root.path, rel)
          await ensureDir(path.dirname(full))
          if (encoding === 'base64') {
            await fsp.writeFile(full, Buffer.from(content, 'base64'))
          } else {
            await fsp.writeFile(full, content, 'utf8')
          }
          res.json({ ok: true })
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      // Rename a file within the configured root.
      router.post(`/files/rename`, async (req, res) => {
        try {
          const rel = req.body && req.body.path
          const newRel = req.body && req.body.newPath
          if (!rel || !newRel) return res.status(400).json({ ok: false, error: 'Missing path/newPath' })
          const root = resolveRoot(req.body?.root)
          const src = safeJoin(root.path, rel)
          const dst = safeJoin(root.path, newRel)
          await ensureDir(path.dirname(dst))
          await fsp.rename(src, dst)
          res.json({ ok: true })
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      // Delete a file or empty directory.
      router.post(`/files/delete`, async (req, res) => {
        try {
          const rel = req.body && req.body.path
          if (!rel) return res.status(400).json({ ok: false, error: 'Missing path' })
          const root = resolveRoot(req.body?.root)
          const target = safeJoin(root.path, rel)
          const st = await fsp.stat(target)
          if (st.isDirectory()) {
            const entries = await fsp.readdir(target)
            if (entries.length) return res.status(400).json({ ok: false, error: 'Directory not empty' })
            await fsp.rmdir(target)
          } else {
            await fsp.unlink(target)
          }
          res.json({ ok: true })
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      // Handle goto command for a selected waypoint.
      router.post(`/goto`, async (req, res) => {
        try {
          const wp = req.body && req.body.waypoint ? req.body.waypoint : null // Extract waypoint payload.
          if (!wp || !wp.position || wp.position.latitude == null || wp.position.longitude == null) {
            return res.status(400).json({ ok: false, error: 'Missing waypoint.position.{latitude,longitude}' })
          }

          const lat = Number(wp.position.latitude) // Normalize latitude.
          const lon = Number(wp.position.longitude) // Normalize longitude.
          const name = wp.name || wp.id || 'Waypoint' // Friendly display name.
          const href = wp.id ? `/signalk/v2/api/resources/waypoints/${encodeURIComponent(wp.id)}` : null // Optional href.

          const destination = {
            name,
            position: { latitude: lat, longitude: lon },
            ...(href ? { href } : {}) // Include href only when present.
          }
          const useCourseApi = typeof app.setDestination === 'function' // Determine if modern API is available.
          if (useCourseApi) {
            const result = app.setDestination(destination) // Request destination via helper.
            if (result && typeof result.then === 'function') {
              await result // Await promise-based implementations.
            }
            lastMessage = `Destination set via Course API: ${name}`
          } else {
            const timestamp = new Date().toISOString() // Timestamp for delta.
            const delta = {
              context: 'vessels.self',
              updates: [{
                source: { label: plugin.id, type: 'plugin' },
                timestamp,
                values: [
                  {
                    path: 'navigation.courseRhumbline.nextPoint.position',
                    value: { latitude: lat, longitude: lon }
                  },
                  {
                    path: 'navigation.courseRhumbline.nextPoint.name',
                    value: name
                  },
                  ...(href ? [{
                    path: 'navigation.courseRhumbline.nextPoint.href',
                    value: href
                  }] : [])
                ]
              }]
            }

            app.handleMessage(plugin.id, delta) // Send delta through Signal K.
            lastMessage = `Destination set via delta fallback: ${name}`
          }
          res.json({ ok: true })
        } catch (e) {
          res.status(500).json({ ok: false, error: e.message || String(e) })
        }
      })

      // Placeholder show endpoint kept for compatibility with existing UI hooks.
      router.post(`/plugins/${plugin.id}/show`, (req, res) => {
        const wp = req.body && req.body.waypoint ? req.body.waypoint : null

        res.status(200).json({
          result: {
            message: 'ok'
          }
        })
      })
    }

    // Subscribe to vessel position; keeps plugin active and ready for future hooks.
    let stream = app.streambundle.getSelfStream('navigation.position')
    if (options && options.interval > 0) {
      stream = stream.debounceImmediate(options.interval * 1000)
    } else {
      stream = stream.take(1)
    }
    plugin.unsubscribes.push(
        stream.onValue(function (position) {}) // Keep reference for cleanup.
    )
  }

  // Stop hook used by Signal K when disabling the plugin.
  plugin.stop = function () {
    plugin.unsubscribes.forEach(f => f())
  }

  // Export plugin descriptor to Signal K.
  return plugin
}
