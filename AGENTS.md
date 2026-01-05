# AGENTS

## Purpose
Signal K Node Server plugin serving a webapp to manage navigation resources: waypoints, routes, tracks.

## Agent-friendly tasks
- Expand OpenBridge icon manifest (`public/icons.json`) and improve icon previews.
- Improve GPX/KML compatibility (additional variants, routes/tracks support).
- Enhance Freeboard map integration (GeoJSON layers, selections, etc.).
- Add tests for parsers/serializers.
- Add line-by-line pedagogical comments.

## Guidelines
- Keep the webapp dependency-free (plain ES modules; no build step).
- Use OpenBridge icons for UI.
- Rely on Signal K authentication/authorization.
