# SC Overlay social chat — backend A/B

EVE-style player chat for the overlay, with a three-tier channel hierarchy that follows the
Game.log:

| channel | who | from |
|---|---|---|
| `global` | everyone using the app | always joined |
| `region:use1b` | same region/AZ — "the server" in player speak | segment 2 of the shard id |
| `shard:pub_use1b_12326004_040` | same universe instance — people you can actually meet | `<Join PU>` / `<Update Shard Id>` log lines |

Two backends are being A/B-tested (2026-08-08). The **sidecar** (`src/chat.ts`) holds the one
socket and fans out to the Chat widget over SSE; which backend it dials is `config.chatBackend`
(`"custom"` | `"centrifugo"`).

## A — custom (`server.mjs`)

Full protocol: 3-tier auto-channels, per-room history, presence counts, rate limiting, bans.

```
npm run chat-server          # ws://127.0.0.1:8788/ws
```

- `CHAT_AUTH=dev` (default): the client's `hello.handle` is trusted. **Local testing only.**
- `CHAT_AUTH=site`: resolves the overlay sync token via `CHAT_AUTH_URL`
  (default `https://subliminal.gg/api/sc/chat-auth` — endpoint is site-side work, not built yet).
  Expected reply: `{ handle, verified }`; non-verified accounts are refused. **This is the
  production mode — chat requires an RSI-verified account so identities are bannable.**
- Bans: `POST 127.0.0.1:8788/admin/ban {"handle":"..."}` (loopback-only), persisted to
  `data/bans.json`. `/admin/unban`, `GET /admin/bans`.
- History is in-memory (ring of 200/room) — production home is the subliminal-gg stack with
  Postgres persistence.

Test: `node chat-server/server.test.mjs` (spawns the real server on a scratch port).

## B — Centrifugo (`centrifugo/`)

Deliberately shallow per Sub's instruction: **one global room**, live messages only. The sidecar
speaks a minimal hand-rolled slice of Centrifugo's JSON client protocol (connect / subscribe /
publish / ping-echo) — if this arm wins the A/B, switch to the official `centrifuge` npm client
and site-minted JWTs.

```
scoop install centrifugo     # installed 2026-08-08 (v6.9.1)
npm run chat-centrifugo      # ws://127.0.0.1:8799/connection/websocket
```

`centrifugo/config.json` runs insecure client mode (no auth!) — local A/B only.

## Both at once

`npx tsx src/chat.test.ts` drives the sidecar's ChatClient against BOTH real backends
(spawns them itself). `npm run test:chat` runs everything.
