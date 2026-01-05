# FairWindSK integration

The FairWindSK project can surface routes and waypoints managed by MyData through the Signal K resources API.

## Endpoints to use

- Waypoints: `GET /signalk/v2/api/resources/waypoints`
- Routes: `GET /signalk/v2/api/resources/routes`
- Tracks: `GET /signalk/v2/api/resources/tracks`

## Workflow

1. Use the MyData webapp to create or edit waypoints and routes. Each item includes an optional OpenBridge icon in `properties.icon`.
2. FairWindSK clients can poll the endpoints above or subscribe to resource deltas to stay in sync.
3. To highlight a waypoint selected in FairWindSK on the map, POST to `/plugins/signalk-mydata-plugin/show` with `{ waypoint: { id, name, position } }`.

## Permissions

- Ensure the FairWindSK user/token has read access to resources and plugin endpoints.
- All file CRUD operations stay within the configured `remoteFileRoot`, keeping FairWindSK interactions isolated from the underlying filesystem.
