# Hit Machar – Endless Stick Shooter

A mosquito-swatting web game recreated from the reference gameplay video.
**Hold** the screen to aim (dashed line), **release** to fire a laser. Every kill is +1.

```
hit-machar/
  client/   Next.js 14 (App Router) – canvas game, UI, sounds, images
  server/   (legacy Express API – no longer used; API now lives in client/app/api)
```

## Run it

```bash
cd client && npm install
# put your MongoDB Atlas URI in client/.env  (MONGODB_URI=...)
npm run dev                           # http://localhost:3000
```
The game plays without MongoDB; only the global ranking needs it.

## Global ranking
- First time you press PLAY the game asks for a name – **optional**, players can skip and just play.
- Players with a name are saved automatically (on pause / tab hidden). Only each player's **best** run counts.
- Menu → **🌍 Global Ranking** shows the top 50 by kills (ties: less time first) and your own rank.
- Players are identified by a random id kept in `localStorage` (never shown publicly).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/scores?limit=50&clientId=` | ranking `{ scores, me }` |
| POST | `/api/scores` | `{ clientId, name, kills, seconds }` → `{ rank, improved, entry }` |
| GET | `/api/stats` | total kills / ranked players / best |

Config lives in `client/.env`: `MONGODB_URI` (required for ranking), `MONGODB_DB` (default `hitmachar`).
Collections: `players` (one doc per player), `ratelimits` (TTL, auto-cleaned).

## How it matches the video
Timings come from frame/audio analysis of the reference clip (`client/lib/engine.js` header + `FLIGHT`):
- **Mosquito** flies in from the left at ~0.8 screen-widths/s (first pass), leaves, then returns the other way at ~1.1 w/s (second pass) – one 8.6 s cycle, then respawn. After a kill the next one spawns 0.5 s later.
- **Buzz sound** (8 s clip) restarts with every spawn and fades out on a kill; its loudest moment lines up with the first fly-by.
- **Fire sound** plays at the instant of release together with the laser (0.22 s orange beam + muzzle flash).
- **Hit** = ring + confetti burst + floating "+1" and the counter pops.
- "HOLD = AIM • RELEASE = FIRE" hint fades out ~4.5 s after PLAY.
- Pause button (top-right), `Esc`/`P` also pause; the game auto-pauses when the tab is hidden.

Assets live in `client/public/img` (boy, mosquito) and `client/public/sounds` (mosquito.mp3, fire.mp3).
Debug: open `/?debug` to get `window.__hitMachar` (the engine instance).

## Deploy on Vercel (one project)
1. Create a free MongoDB Atlas cluster. In Atlas → *Network Access* allow `0.0.0.0/0` (Vercel IPs change).
2. Open `client/.env` and paste your connection string into `MONGODB_URI=`.
3. Push to a **private** GitHub repo (the `.env` file is committed on purpose – a public repo would expose your DB password).
4. Vercel → **Add New → Project** → import → **Root Directory = `client`** → Deploy. Nothing to set in Vercel's env settings.
