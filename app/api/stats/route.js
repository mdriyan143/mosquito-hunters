import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDb();
    if (!db) return Response.json({ totalKills: 0, players: 0, best: 0 });
    const [agg] = await db
      .collection('players')
      .aggregate([{ $group: { _id: null, totalKills: { $sum: '$kills' }, players: { $sum: 1 }, best: { $max: '$kills' } } }])
      .toArray();
    return Response.json({ totalKills: agg?.totalKills ?? 0, players: agg?.players ?? 0, best: agg?.best ?? 0 });
  } catch (err) {
    console.error('GET /api/stats', err);
    return Response.json({ error: 'Stats unavailable' }, { status: 503 });
  }
}
