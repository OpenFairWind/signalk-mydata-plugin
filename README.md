# Signal K Webapp: MyData (Waypoints / Routes / Tracks)

A **Signal K Node Server** plugin that provides a lightweight webapp to browse and manage:

- **Waypoints** (distance + bearing from vessel position, **GoTo** button)
- **Routes**
- **Tracks**

Features:
- Waypoint **distance / bearing** (computed from `vessels.self.navigation.position`)
- **GoTo** (publishes `navigation.courseRhumbline.nextPoint.*`)
- **Show on map** (publishes best-effort GeoJSON `plugins.nav-manager.selectedFeature`)
- **Edit** & **Delete** waypoints
- Advanced **sorting** and **filtering**
- Waypoint icon selection (OpenBridge icons)
- Import/Export **CSV**, **GPX**, **KML** (currently implemented for **waypoints**)

UI icons source:
https://www.openbridge.no/cases/openbridge-icons

## Install

From Signal K Node Server UI:
1. Server → Plugin Config → **Get**
2. Search: `signalk-mydata-plugin`
3. Install and enable

## Open

Default mount path: `/webapps/nav-manager`

## Notes

- CRUD uses the standard Signal K resources API:
  - `/signalk/v1/api/resources/waypoints`
  - `/signalk/v1/api/resources/routes`
  - `/signalk/v1/api/resources/tracks`

## License

MIT — see [LICENSE.md](./LICENSE.md)
