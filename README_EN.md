# Rezona Lab Engine Bridge

English | [中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Language: TypeScript](https://img.shields.io/badge/Language-TypeScript-3178c6.svg)
![Language: C#](https://img.shields.io/badge/Language-C%23-512bd4.svg)
[![CI](https://github.com/rezona-ai/rezonalab-engine-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/rezona-ai/rezonalab-engine-bridge/actions/workflows/ci.yml)

Push assets generated on the Rezona Lab canvas (glb, images, audio, sprites) straight into a Cocos Creator or Unity project running on the same machine. There are exactly two parties: the web page is the client, the plugin inside the engine is a WebSocket server bound to `127.0.0.1`. No accounts, no pairing, no server-side job queue.

## How it works

1. The user flips an engine toggle in the workbench "Engine Bridge" panel. The page probes that engine's port range in parallel (Cocos `41700–41719`, Unity `41720–41739`), handshakes with the first plugin that answers and keeps the connection alive.
2. "Send to → engine" on a canvas card computes a sha256, streams the bytes in 4 MB chunks; the plugin writes to a temp file as it receives, verifies, atomically moves the file into `assets/RezonaAssets/`, imports it into the asset database and instantiates it in the scene.
3. Five hardening measures: Origin allowlist, port fallthrough for multiple instances of the same engine, an upfront note about the browser permission prompt, zip path-traversal checks, streaming writes with chunk and size limits.

The protocol lives in [`protocol/spec.md`](protocol/spec.md); recorded fixtures in [`protocol/fixtures/`](protocol/fixtures/) must pass on both the TypeScript and the C# implementation.

## Layout

| Path | Contents |
|---|---|
| `protocol/` | Protocol v1 spec, JSON Schemas, 11 recorded fixtures |
| `packages/core-ts/` | Engine-agnostic TypeScript kernel (framing, chunked receiver, heartbeat, state machine, port allocation, origin check, safe unzip, ws server assembly) |
| `packages/web-client/` | Browser package `@rezonalab/engine-bridge-web` |
| `packages/cocos/` | Cocos Creator 3.8.5+ extension, built to `dist/rezona-bridge-cocos-<ver>.zip` |
| `packages/unity/` | Unity 2021.3+ UPM package `com.rezonalab.engine-bridge` (C# port of the kernel) |
| `docs/` | [Cocos install](docs/install-cocos.md), [Unity install](docs/install-unity.md), [game-web integration](docs/game-web-integration.md) |
| `scripts/` | Fake engine, version sync, break-verify, Unity test driver |

## Developer commands

```bash
npm ci
npm test                 # kernel + web client tests (11 fixtures, count asserted so none are skipped)
npm run typecheck
npm run build:cocos      # emits dist/rezona-bridge-cocos-<ver>.zip (< 100 MB)
npm run test:unity       # C# fixture tests (EditMode) when Unity is installed locally
npm run break:verify     # mutation check: disable sha256 / Origin / zip validation one at a time, the matching fixture must go red, then restore
npm run sync:version     # copy the root package.json version into every package manifest and the web client's pluginVersion
npm run dev:fake-engine -- --origin http://localhost:3000   # fake engine on 41700 for local game-web development
```

Run `node scripts/fake-engine.mjs --help` for every flag: `--engine`, `--project-dir`, `--name`, `--origin` (repeatable), `--max-file-bytes`, `--protocol` (anything other than 1 answers every hello with `PROTOCOL_MISMATCH`), `--port-range`. A second instance lands on 41701 automatically.

## Installing the plugins

- Cocos Creator: [docs/install-cocos.md](docs/install-cocos.md) (Chinese)
- Unity: [docs/install-unity.md](docs/install-unity.md) (Chinese)

## Boundaries

- Web page and engine must run on the same machine.
- Chrome 142+ shows a "connect to devices on your local network" permission prompt on first connect; Safari is not supported.
- The server never sees the export happen; export telemetry, one-time nonces and push-by-URL are deferred to a later phase.

## Releasing

The root `package.json` version is the single source of truth: bump it → `npm run sync:version` → commit → tag `v<ver>` → CI builds the Cocos zip; Unity users upgrade by changing the git URL tag.

## License

MIT
