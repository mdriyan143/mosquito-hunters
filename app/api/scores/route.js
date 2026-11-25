import { getDb, CLIENT_ID_RE, cleanName, rankOf } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status = 200) => Response.json(body, { status });

/** GET /api/scores?limit=50&clientId=...  -> { scores:[{rank,name,kills,seconds,isMe}], me } */
export async function GET(request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 10, 1), 100);
  const clientId = url.searchParams.get('clientId') || '';

  try {
    const db = await getDb();
    if (!db) return json({ scores: [], me: null });
    const players = db.collection('players');

    const docs = await players
      .find({}, { projection: { _id: 0, clientId: 1, name: 1, kills: 1, seconds: 1 } })
      .sort({ kills: -1, seconds: 1, at: 1 })
      .limit(limit)
      .toArray();

    const scores = docs.map((d, i) => ({
      rank: i + 1,
      name: d.name,
      kills: d.kills,
      seconds: d.seconds,
      isMe: Boolean(clientId) && d.clientId === clientId, // clientId itself is never sent out
    }));

    let me = null;
    if (CLIENT_ID_RE.test(clientId)) {
      const mine = await players.findOne({ clientId });
      if (mine) me = { name: mine.name, kills: mine.kills, seconds: mine.seconds, rank: await rankOf(players, mine.kills, mine.seconds) };
    }
    return json({ scores, me });
  } catch (err) {
    console.error('GET /api/scores', err);
    return json({ error: 'Leaderboard unavailable' }, 503);
  }
}

/** POST /api/scores { clientId, name, kills, seconds } -> keeps each player's BEST run */
export async function POST(request) {
  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error('mongo connect', err);
    return json({ error: 'Leaderboard unavailable' }, 503);
  }
  if (!db) return json({ error: 'Leaderboard not configured' }, 503);

  // rate limit: 30 writes / minute / IP (TTL-cleaned collection)
  const ip = (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  const bucket = `${ip}:${Math.floor(Date.now() / 60_000)}`;
  const rl = await db.collection('ratelimits').findOneAndUpdate(
    { _id: bucket },
    { $inc: { n: 1 }, $setOnInsert: { expireAt: new Date(Date.now() + 120_000) } },
    { upsert: true, returnDocument: 'after' }
  );
  if ((rl?.n ?? rl?.value?.n ?? 0) > 30) return json({ error: 'Too many requests' }, 429);

  const body = await request.json().catch(() => ({}));
  const clientId = String(body.clientId || '');
  const name = cleanName(body.name);
  const kills = Number(body.kills);
  const seconds = Math.round(Number(body.seconds));

  if (!CLIENT_ID_RE.test(clientId)) return json({ error: 'Invalid player id' }, 400);
  if (name.length < 2) return json({ error: 'Name must be at least 2 characters' }, 400);
  if (!Number.isInteger(kills) || kills < 1 || kills > 10_000) return json({ error: 'Invalid kills' }, 400);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 6 * 3600) return json({ error: 'Invalid duration' }, 400);
  // a kill needs a spawn delay + one aim/fire cycle (~1s)
  if (kills > Math.ceil(seconds / 1.0) + 1) return json({ error: 'Score rejected' }, 422);

  const players = db.collection('players');
  const now = new Date();
  const existing = await players.findOne({ clientId });
  const better = !existing || kills > existing.kills || (kills === existing.kills && seconds < existing.seconds);

  let best;
  if (!existing) {
    best = { clientId, name, kills, seconds, games: 1, at: now };
    await players.insertOne(best).catch(async (e) => {
      if (e.code !== 11000) throw e; // duplicate from a racing request -> fall through to update
      await players.updateOne({ clientId }, { $set: { name } });
    });
  } else if (better) {
    best = { ...existing, name, kills, seconds, at: now };
    await players.updateOne({ clientId }, { $set: { name, kills, seconds, at: now }, $inc: { games: 1 } });
  } else {
    best = { ...existing, name };
    await players.updateOne({ clientId }, { $set: { name }, $inc: { games: 1 } });
  }

  const rank = await rankOf(players, best.kills, best.seconds);
  return json({ improved: better, rank, entry: { name: best.name, kills: best.kills, seconds: best.seconds } }, 201);
}
