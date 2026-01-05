# Getting started with MyData

This guide walks through enabling the plugin, opening the webapp, and creating your first waypoint.

## Prerequisites

- Signal K Server v2 or later
- A user with permission to access resources endpoints and plugin apps

## Enable the plugin

1. Open **Server → Plugin Config** in the Signal K admin UI.
2. Install **signalk-mydata-plugin** if it is not already available.
3. Enable the plugin and save.

## Open the webapp

- The webapp is served from `/signalk-mydata-plugin`. Navigate to that path in your browser.
- The layout uses the full viewport so you can keep the waypoint list, preview, and editor visible at once.

## Create a waypoint at the vessel position

1. Switch to the **Waypoints** tab.
2. Click **Create at vessel position**. The app uses the v2 Resources API to PUT a waypoint with the vessel's latest position.
3. The table shows bearing and distance that update live via WebSocket without rerendering the actions column.

## Browse remote files

1. Switch to the **Files** tab.
2. Use the breadcrumbs and **Up** button to navigate.
3. Select a file to preview it; click **Fullscreen preview** to temporarily expand it to the entire viewport.
4. Use **New text** or **New image** to open an editor, then click **Save** to write the file server-side.
