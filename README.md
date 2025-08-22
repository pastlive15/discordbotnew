# Discord Bot — Upgraded (2025-08)

This upgrade modernizes your bot for **Node.js 20+**, **discord.js v14.22.x**, adds **linting/formatting**, safer **env handling**, and removes hard‑coded secrets.

## What changed

- **Dependencies**
  - `discord.js` → `^14.22.1`
  - `dotenv` → `^17.2.1`
  - `mongodb` → `^6.18.0`
  - `pg` → `^8.16.3`
  - Added `pino` for logs; `pino-pretty` in dev
  - Removed built‑ins from deps (`fs`, `path`), fixed `nodeman` → `nodemon`
- **Security**
  - Replaced hard‑coded webhook URL with `ERROR_WEBHOOK_URL` in env.
  - `deploy-commands.js` now reads `DISCORD_TOKEN`, `CLIENT_ID`, `DEV_GUILD_ID` from env (no `config.json`).
  - Added `.gitignore` and `.env.example`.
- **DX**
  - ESLint + Prettier + Husky pre-commit
  - Centralized logger at `utils/logger.js` (pino).
- **DB**
  - `db.js` supports `DATABASE_URL` and optional TLS via `PGSSL=require`.

## Quick start

1. **Use Node 22 LTS** (or newer).  
2. Copy `.env.example` → `.env` and fill out values.
3. Install deps:

   ```bash
   npm i
   ```

4. **Deploy slash commands** (guild dev mode recommended at first):

   ```bash
   # edit DEV_GUILD_ID in .env to your test guild ID
   node deploy-commands.js
   ```

5. **Run the bot:**

   ```bash
   npm run dev   # with nodemon
   # or
   npm start
   ```

## Environment variables

See `.env.example` for the full list. Required:
- `DISCORD_TOKEN`
- `CLIENT_ID`
- Either `DATABASE_URL` or `PG_*` variables
- Optional: `ERROR_WEBHOOK_URL` for error notifications, `DEV_GUILD_ID` for faster command deploys.

## Important security note

Your previous repo had secrets checked in (bot token / DB password / webhook). **Immediately rotate** any exposed tokens and passwords before pushing these changes anywhere.

## Scripts

- `npm run dev` – dev server with `nodemon`
- `npm start` – run once
- `npm run lint` – ESLint check
- `npm run format` – Prettier write

## Suggested next steps

- Add unit tests (Vitest or Jest) for core utils and command handlers.
- Consider rate limiting or per‑user cooldowns on commands.
- If you rely on images, keep `@napi-rs/canvas` up to date with your host OS.
