# `extensions/` Agent Guide

`extensions/` contains browser connectors that send papers and readable web
pages to the RustyReader desktop connector at `http://127.0.0.1:17654`.

## Layout

- `chrome/`: Chrome Manifest V3 extension.
- `safari/`: Safari Web Extension source and packaging scripts.

Chrome owns the shared implementation. The Safari build copies Chrome's
`extension/` tree, then overlays only Safari-specific files:

- `manifest.json`: browser extension manifest.
- Chrome's `extension/`: background worker, popup JavaScript, and shared logic.
- Safari's `extension/`: browser-specific HTML, CSS, and assets only.
- `extension/assets/`: extension icons.
- `scripts/`: local packaging/mock/smoke helpers.
- `tests/` exists for Chrome; Safari shares most logic through mirrored source.

## Connector Contract

- Desktop connector implementation: `src-tauri/src/connector.rs`.
- API docs: `extensions/chrome/docs/rustyreader-connector-api.md`.
- Keep Chrome and Safari route assumptions synchronized with the desktop
  connector whenever request/response shapes change.
- Chrome supports downloads APIs and context menus. Safari lacks Chrome's
  downloads API, so Safari import behavior may need separate fetch/upload paths.

## Common Checks

- Root Chrome tests: `rtk npm run extension:test`
- Chrome smoke: `rtk npm run extension:smoke`
- Chrome package: `rtk npm run extension:package`
- Safari build: `rtk npm run extension:safari:build`
- Safari package: `rtk npm run extension:safari:package`
