# SC Overlay social chat server

EVE-style player chat for the overlay, with a three-tier channel hierarchy that follows the
Game.log:

| channel | who | from |
|---|---|---|
| `global` | everyone using the app | always joined |
| `region:use1b` | same region/AZ — "the server" in player speak | segment 2 of the shard id |
| `shard:pub_use1b_12326004_040` | same universe instance — people you can actually meet | `<Join PU>` / `<Update Shard Id>` log lines |

The **sidecar** (`src/chat.ts`) holds the one socket per app and fans out to the Chat widget
over SSE. No socket exists unless the widget is open.

> A Centrifugo arm was A/B-tested on 2026-08-08 and retired the same day — same product work
> either way, one more service to run, and it needed a local-echo workaround. The adapter
> lives in git history if ever wanted.

## Running

```
npm run chat-server          # ws://127.0.0.1:8788/ws
```

- `CHAT_AUTH=dev` (default): the client's `hello.handle` is trusted. **Local testing only.**
- `CHAT_AUTH=site`: resolves the overlay sync token via `CHAT_AUTH_URL`
  (default `https://subliminal.gg/api/sc/chat-auth`). Expected reply: `{ handle, verified }`;
  non-verified accounts are refused. **This is the production mode — chat requires an
  RSI-verified account so identities are bannable.**
- `CHAT_PORT` (default 8788).
- Bans: `POST 127.0.0.1:8788/admin/ban {"handle":"..."}` (loopback-only), persisted to
  `data/bans.json`. `/admin/unban`, `GET /admin/bans`.
- History is in-memory (ring of 200/room); the region/shard rooms are ephemeral by nature
  (shards churn every patch), global scrollback resets on restart. Postgres persistence is
  future site-side work.

## Tests

`node chat-server/server.test.mjs` (protocol) · `npx tsx src/chat.test.ts` (the sidecar
client against a real spawned server) · `npm run test:chat` (both).
