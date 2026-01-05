/*
 * Signal K Node Server plugin: signalk-webapp-nav-manager
 *
 * - Serves a webapp at /webapps/nav-manager
 * - Adds a small API endpoint to set "goto" to a waypoint (publishes deltas)
 *
 * Notes:
 * - The UI uses the server's existing REST resources endpoints directly:
 *   /signalk/v1/api/resources/{waypoints|routes|tracks}
 *   so authentication/permissions are handled by the Signal K server.
 */
const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const Busboy = require('busboy')
module.exports = function (app) {
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

  var plugin = {
    unsubscribes: []
  }

  plugin.id = "signalk-mydata-plugin"
  plugin.name = 'MyData (Waypoints/Routes/Files)'
  plugin.description = 'A web application to manage waypoints, tracks, and files.'


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
      interval: {
        type: 'number',
        title: 'Interval',
        default: 0
      }
    }
  })

  let lastMessage = ''
  plugin.statusMessage = function () {
    return `${lastMessage}`
  }

  plugin.start = function (options) {
    const remoteRoot = (options && options.remoteFileRoot) ? options.remoteFileRoot : '/var/lib/signalk/mydata-files'
    const express = app.express

    plugin.registerWithRouter = (router) => {


      const TEXT_EXTS = ['.txt','.log','.md','.json','.geojson','.gpx','.kml','.csv','.xml','.yaml','.yml']
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

      async function ensureDir(p) {
        await fsp.mkdir(p, { recursive: true })
      }

      function statToEntry(name, st) {
        return {
          name,
          type: st.isDirectory() ? 'dir' : 'file',
          size: st.isDirectory() ? null : st.size,
          mtime: st.mtime ? st.mtime.toISOString() : null
        }
      }

      router.get(`/files/list`, async (req, res) => {
        try {
          const rel = req.query.path || ''
          const dir = safeJoin(remoteRoot, rel)
          await ensureDir(dir)
          const entries = []
          const names = await fsp.readdir(dir)
          for (const name of names) {
            const st = await fsp.stat(path.join(dir, name))
            entries.push(statToEntry(name, st))
          }
          entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)))
          res.json({ ok: true, path: rel, entries })
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      router.get(`/files/read`, async (req, res) => {
        try {
          const rel = req.query.path
          if (!rel) return res.status(400).json({ ok: false, error: 'Missing path' })
          const full = safeJoin(remoteRoot, rel)
          const st = await fsp.stat(full)
          if (!st.isFile()) return res.status(400).json({ ok: false, error: 'Not a file' })
          if (st.size > 2 * 1024 * 1024) {
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

      router.get(`/files/download`, async (req, res) => {
        try {
          const rel = req.query.path
          if (!rel) return res.status(400).json({ ok: false, error: 'Missing path' })
          const full = safeJoin(remoteRoot, rel)
          const st = await fsp.stat(full)
          if (!st.isFile()) return res.status(400).json({ ok: false, error: 'Not a file' })
          res.setHeader('Content-Disposition', `attachment; filename="${path.basename(full)}"`)
          res.setHeader('Content-Type', 'application/octet-stream')
          fs.createReadStream(full).pipe(res)
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      router.post(`/files/mkdir`, async (req, res) => {
        try {
          const rel = req.body && req.body.path
          if (!rel) return res.status(400).json({ ok: false, error: 'Missing path' })
          const full = safeJoin(remoteRoot, rel)
          await ensureDir(full)
          res.json({ ok: true })
        } catch (e) {
          res.status(400).json({ ok: false, error: e.message || String(e) })
        }
      })

      router.post(`/files/upload`, (req, res) => {
        const bb = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } })
        let dirRel = ''
        let saved = []

        bb.on('field', (name, val) => {
          if (name === 'dir') dirRel = val || ''
        })

        bb.on('file', (name, file, info) => {
          const filename = info.filename || 'upload.bin'
          try {
            const dirFull = safeJoin(remoteRoot, dirRel)
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

      router.post(`/goto`, (req, res) => {
        try {
          const wp = req.body && req.body.waypoint ? req.body.waypoint : null
          if (!wp || !wp.position || wp.position.latitude == null || wp.position.longitude == null) {
            return res.status(400).json({ ok: false, error: 'Missing waypoint.position.{latitude,longitude}' })
          }

          const lat = Number(wp.position.latitude)
          const lon = Number(wp.position.longitude)
          const name = wp.name || wp.id || 'Waypoint'
          const href = wp.id ? `/signalk/v2/api/resources/waypoints/${encodeURIComponent(wp.id)}` : null

          const timestamp = new Date().toISOString()
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

          app.handleMessage(plugin.id, delta)
          res.json({ ok: true })
        } catch (e) {
          res.status(500).json({ ok: false, error: e.message || String(e) })
        }
      })

      router.post(`/plugins/${plugin.id}/show`, (req, res) => {
        const wp = req.body && req.body.waypoint ? req.body.waypoint : null

        res.status(200).json({
          result: {
            message: 'ok'
          }
        })
      })
    }

    let stream = app.streambundle.getSelfStream('navigation.position')
    if (options && options.interval > 0) {
      stream = stream.debounceImmediate(options.interval * 1000)
    } else {
      stream = stream.take(1)
    }
    plugin.unsubscribes.push(
        stream.onValue(function (position) {})
    )
  }

  plugin.stop = function () {
    plugin.unsubscribes.forEach(f => f())
  }

  return plugin
}
