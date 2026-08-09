-- SC Overlay chat — Postgres schema (Timescale instance, `chat` schema, role chat_app).
--
-- Scrollback used to be an in-memory ring per room, so every Coolify redeploy silently wiped
-- every conversation in every channel. It also made DMs pointless: a message to someone who is
-- offline has to survive until they come back, and nothing here survived a restart.
--
-- Idempotent — safe to re-run. The server applies it on boot when DATABASE_URL is set.
--
-- 🔑 Table names are UNQUALIFIED on purpose: the pool sets search_path from CHAT_DB_SCHEMA
-- (default `chat`), so the same file builds a scratch schema for the store test. Hard-coding
-- `chat.` here would mean the Postgres path could only ever be exercised against live chat.

CREATE TABLE IF NOT EXISTS messages (
  id        bigint PRIMARY KEY,          -- assigned by the server, monotonic across restarts
  ch        text        NOT NULL,
  handle    text        NOT NULL,
  verified  boolean     NOT NULL DEFAULT true,
  text      text        NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
-- The only read pattern: the last N of one channel, newest first.
CREATE INDEX IF NOT EXISTS messages_ch_id ON messages (ch, id DESC);

-- Custom rooms. Replaces data/channels.json, which held only { label, created, lastActive }.
--   category  one of the activity slugs in ROOM_CATEGORIES (server.mjs) — how the directory groups
--   privacy   'public'  listed in the directory, anyone may join
--             'private' unlisted; entry needs the join CODE or an invite
--   code      short shareable code, private rooms only
CREATE TABLE IF NOT EXISTS rooms (
  slug        text PRIMARY KEY,
  label       text        NOT NULL,
  category    text        NOT NULL DEFAULT 'social',
  privacy     text        NOT NULL DEFAULT 'public',
  code        text,
  owner       text,                                  -- lowercase handle of the creator
  created     timestamptz NOT NULL DEFAULT now(),
  last_active timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rooms_privacy CHECK (privacy IN ('public', 'private'))
);
-- A code has to identify exactly one room to be worth typing. Partial: public rooms have none.
CREATE UNIQUE INDEX IF NOT EXISTS rooms_code ON rooms (code) WHERE code IS NOT NULL;

-- Invite-by-handle, the second way into a private room. Handles are stored lowercase; the RSI
-- handle is the identity everywhere in this server.
CREATE TABLE IF NOT EXISTS room_invites (
  slug       text        NOT NULL REFERENCES rooms(slug) ON DELETE CASCADE,
  handle     text        NOT NULL,
  invited_by text        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, handle)
);

-- Bans. Replaces data/bans.json. The whole point of the RSI-verify gate is that these stick.
CREATE TABLE IF NOT EXISTS bans (
  handle text PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now()
);

-- One row per DM conversation, so a player's DM list is one indexed read rather than a scan of
-- every dm: channel. `a` is always the lexicographically smaller handle — the pair is the
-- identity, and storing it ordered is what stops (a,b) and (b,a) becoming two conversations.
CREATE TABLE IF NOT EXISTS dm_threads (
  a         text NOT NULL,
  b         text NOT NULL,
  last_at   timestamptz NOT NULL DEFAULT now(),
  a_read_at timestamptz,
  b_read_at timestamptz,
  PRIMARY KEY (a, b),
  CONSTRAINT dm_ordered CHECK (a < b)
);
CREATE INDEX IF NOT EXISTS dm_threads_a ON dm_threads (a, last_at DESC);
CREATE INDEX IF NOT EXISTS dm_threads_b ON dm_threads (b, last_at DESC);
