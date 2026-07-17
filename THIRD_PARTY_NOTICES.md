# Third-party notices

## ws (https://github.com/websockets/ws)

MIT License — Copyright (c) 2011 Einar Otto Stangvik; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors.

Used by the Node sidecar and the mock Streamer.bot test server. Not shipped to the browser — the overlay and control page use the built-in browser WebSocket.

## playwright-core (optional, dev only)

Apache License 2.0 — Copyright (c) Microsoft Corporation.

Used only by `npm run verify:render` and `tools/shots.mjs` (installed on demand with `npm i --no-save playwright-core`); never a runtime dependency.
