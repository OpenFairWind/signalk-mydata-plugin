# Configure MyData

MyData relies on the Signal K Resources API and a configurable server-side file root.

## Plugin options

- **Remote files root directory**: absolute directory the Files tab can read and write. Path traversal is blocked, and empty directories can be removed. Default: `/var/lib/signalk/mydata-files`.
- **Interval**: optional debounce interval (seconds) for navigation position subscription used by the plugin lifecycle.

## Authentication and authorization

- The webapp uses the Signal K session for fetch calls and WebSocket connections.
- REST operations target the v2 endpoints: `/signalk/v2/api/resources/{waypoints|routes|tracks}`.

## File operations

- **List / Preview / Download**: available for any file under the configured root. Inline previews are limited to 5 MB for safety.
- **Create / Edit**: the **Save** button writes text as UTF-8 or binary images as base64 via `/plugins/signalk-mydata-plugin/files/write`.
- **Rename**: uses `/plugins/signalk-mydata-plugin/files/rename` with traversal checks.
- **Delete**: files are removed directly; directories must be empty before deletion.

## UI behaviors

- The application stretches to the browser viewport for maximum workspace.
- Preview and editor panels can be toggled to full-viewport overlays without permanently resizing the layout.
- Waypoint action buttons are stable while distance/bearing values refresh from live vessel data.
