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
  plugin.name = 'MyData (Waypoints/Routes/Tracks)'
  plugin.description = 'A web application to manage waypoints, tracks, and routes.'

  plugin.schema = () => ({
    title: 'Mange my data',
    type: 'object',
    properties: {
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
    const mountPath = (options && options.mountPath) ? options.mountPath : '/webapps/mydata'
    const express = app.express

    plugin.registerWithRouter = (router) => {

      router.post('/plugins/${plugin.id}/goto', (req, res) => {
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
              source: { label: plugin.Id },
              timestamp,
              values: [
                {
                  path: 'navigation.courseRhumbline.nextPoint.position',
                  value: { latitude: lat, longitude: lon }
                },
                {
                  path: 'navigation.courseRhumbline.nextPoint.name',
                  value: name
                }
              ]
            }]
          }

          app.handleMessage(plugin.ic, delta)
          res.json({ ok: true })
        } catch (e) {
          res.status(500).json({ ok: false, error: e.message || String(e) })
        }
      })

      router.post('/plugins/${plugin.id}/show', (req, res) => {
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