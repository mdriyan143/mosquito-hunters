import { MongoClient } from 'mongodb';

// Atlas connection string, e.g. mongodb+srv://user:pass@cluster.mongodb.net/
// (the Vercel Marketplace MongoDB Atlas integration sets MONGODB_URI for you)
const uri =
  process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGOURI || process.env.MONGODB_URL;
export const dbConfigured = Boolean(uri);

/** Cached across hot reloads / warm serverless invocations. Resolves to a Db, or null when not configured. */
export function getDb() {
  if (!uri) return Promise.resolve(null);
  if (!globalThis._hitMacharDb) {
    globalThis._hitMacharDb = (async () => {
      const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 6000 });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'hitmachar');
      await Promise.all([
        db.collection('players').createIndex({ clientId: 1 }, { unique: true }),
        db.collection('players').createIndex({ kills: -1, seconds: 1, at: 1 }),
        db.collection('ratelimits').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      ]);
      return db;
    })().catch((err) => {
      globalThis._hitMacharDb = null; // allow retry on next request
      throw err;
    });
  }
  return globalThis._hitMacharDb;
}

export const CLIENT_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

export const cleanName = (v) =>
  String(v || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);

/** 1-based global rank: players strictly ahead (more kills, or same kills in less time) + 1 */
export async function rankOf(players, kills, seconds) {
  const ahead = await players.countDocuments({
    $or: [{ kills: { $gt: kills } }, { kills, seconds: { $lt: seconds } }],
  });
  return ahead + 1;
}
