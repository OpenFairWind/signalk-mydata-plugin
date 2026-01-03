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

module.exports = function (app) {
  const plugin = {}
  const pluginId = 'signalk-mydata-plugin'
  let router = null

  plugin.id = pluginId
  plugin.name = 'MyData (Waypoints/Routes/Tracks)'
  plugin.description = 'A web application to manage waypoints, tracks, and routes.'

  plugin.schema = {
    type: 'object',
    properties: {
      mountPath: {
        type: 'string',
        title: 'Webapp mount path',
        default: '/webapps/mydata'
      }
    }
  }

  plugin.start = function (options) {
    const mountPath = (options && options.mountPath) ? options.mountPath : '/webapps/nav-manager'
    const express = app.express
    router = express.Router()

    // --- webapp static
    const publicDir = path.join(__dirname, 'public')
    router.use('/', express.static(publicDir, { etag: true, maxAge: '1h' }))

    // --- API: goto (publish nextPoint)
    router.post('/api/goto', express.json({ limit: '512kb' }), (req, res) => {
      try {
        const wp = req.body && req.body.waypoint ? req.body.waypoint : null
        if (!wp || !wp.position || wp.position.latitude == null || wp.position.longitude == null) {
          return res.status(400).json({ ok: false, error: 'Missing waypoint.position.{latitude,longitude}' })
        }

        const lat = Number(wp.position.latitude)
        const lon = Number(wp.position.longitude)
        const name = wp.name || wp.id || 'Waypoint'

        const timestamp = new Date().toISOString()
        const delta = {
          context: 'vessels.self',
          updates: [{
            source: { label: pluginId },
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
              // Best-effort GeoJSON feature for map highlighting
              {
                path: 'plugins.nav-manager.selectedFeature',
                value: {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [lon, lat] },
                  properties: { name, id: wp.id || null, type: 'waypoint' }
                }
              }
            ]
          }]
        }

        app.handleMessage(pluginId, delta)
        res.json({ ok: true })
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message || String(e) })
      }
    })

    app.registerRouter(mountPath, router)
    app.setPluginStatus(`Webapp available at ${mountPath}`)
  }

  plugin.stop = function () {
    router = null
    app.setPluginStatus('Stopped')
  }

  return plugin
}
