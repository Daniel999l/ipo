// X handles: cleaning, checking they exist, profile pictures, and the plain on-chain name each listed coin gets.
import { randomInt } from 'crypto';

export class HandleError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// "@Some_Guy", "x.com/Some_Guy", "https://twitter.com/Some_Guy?s=20" -> { handle: 'Some_Guy', key: 'some_guy' }
export function parseHandle(input) {
  let s = String(input ?? '').trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '');
  s = s.split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) throw new HandleError('That is not a valid X handle.');
  return { handle: s, key: s.toLowerCase() };
}

// Every listed coin gets a plain, random name and ticker on pump.fun. The site shows the handle.
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const TICK = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function coinLabel(serial) {
  const word = Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join('');
  const symbol = Array.from({ length: 5 }, () => TICK[randomInt(TICK.length)]).join('');
  return { name: `${word} ${serial}`, symbol };
}

// ---------- X profiles (name, bio, followers, picture) from FxTwitter's public API
// Returns { status: 'found', profile } | { status: 'missing' } | { status: 'unknown' } (service down, rate limited, off)
export async function fetchProfile(cfg, handle) {
  if (!cfg.profileUrl) return { status: 'unknown' };
  try {
    const r = await fetch(`${cfg.profileUrl}/${encodeURIComponent(handle)}`, { signal: AbortSignal.timeout(8000), redirect: 'manual', headers: { 'user-agent': 'ipo-site/1.0' } });
    if (r.status === 404 || (r.status >= 300 && r.status < 400)) return { status: 'missing' }; // unknown handles redirect away
    if (!r.ok) return { status: 'unknown' };
    const j = await r.json().catch(() => null);
    const u = j?.user;
    if (!u) return j?.code === 404 ? { status: 'missing' } : { status: 'unknown' };
    const big = url => (url ? String(url).replace(/_normal(\.\w+)$/, '_400x400$1') : null);
    return { status: 'found', profile: {
      handle: u.screen_name || handle, name: String(u.name || '').slice(0, 60), bio: String(u.description || '').slice(0, 300),
      followers: Number(u.followers) || 0, following: Number(u.following) || 0, posts: Number(u.tweets) || 0,
      verified: !!u.verification?.verified, protected: !!u.protected, joined: u.joined ? new Date(u.joined) : null,
      avatarUrl: big(u.avatar_url), bannerUrl: u.banner_url || null,
    } };
  } catch { return { status: 'unknown' }; }
}

// Cached profile (12 hours). Missing accounts are remembered for an hour.
export async function getProfile(ctx, key, handle, { maxAgeMs = 12 * 3600000 } = {}) {
  const col = ctx.db.profiles;
  const hit = await col.findOne({ _id: key });
  const age = hit ? Date.now() - new Date(hit.at).getTime() : Infinity;
  if (hit && age < (hit.status === 'found' ? maxAgeMs : 3600000)) return hit;
  const p = await fetchProfile(ctx.cfg, handle);
  if (p.status === 'unknown') return hit || p; // keep what we had
  const doc = { _id: key, status: p.status, profile: p.profile || null, at: new Date() };
  await col.updateOne({ _id: key }, { $set: doc }, { upsert: true });
  if (p.status === 'found') await ctx.db.coins.updateOne({ key }, { $set: { profile: publicProfile(p.profile) } });
  return doc;
}

// the part the site shows
export const publicProfile = p => p ? { name: p.name, bio: p.bio, followers: p.followers, following: p.following, verified: p.verified, protected: p.protected, joined: p.joined } : null;

// Does this handle exist? 'found' | 'missing' | 'unknown'
export async function handleExists(ctx, key, handle) {
  const p = await getProfile(ctx, key, handle);
  if (p.status !== 'unknown') return p.status;
  return (await getAvatar(ctx, key, handle)).status; // fall back to the picture service
}

// ---------- profile pictures
async function fetchImage(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (r.status === 404) return { status: 'missing' };
    if (!r.ok) return { status: 'unknown' };
    const type = r.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return { status: 'unknown' };
    const data = Buffer.from(await r.arrayBuffer());
    if (!data.length || data.length > 2 * 1024 * 1024) return { status: 'unknown' };
    return { status: 'found', type, data };
  } catch { return { status: 'unknown' }; }
}

// Picture from the X profile first, then the backup picture service.
export async function fetchAvatar(ctx, key, handle) {
  const p = ctx.cfg.profileUrl ? await getProfile(ctx, key, handle) : null;
  if (p?.status === 'found' && p.profile?.avatarUrl) {
    const img = await fetchImage(p.profile.avatarUrl);
    if (img.status === 'found') return img;
  }
  if (!ctx.cfg.avatarUrl) return p?.status === 'missing' ? { status: 'missing' } : { status: 'unknown' };
  return fetchImage(`${ctx.cfg.avatarUrl}/${encodeURIComponent(handle)}?fallback=false`);
}

// Cached picture (7 days). Missing accounts are remembered for a day.
export async function getAvatar(ctx, key, handle) {
  const col = ctx.db.avatars;
  const hit = await col.findOne({ _id: key });
  const fresh = hit && Date.now() - new Date(hit.at).getTime() < (hit.status === 'found' ? 7 : 1) * 86400000;
  if (fresh) return hit;
  const a = await fetchAvatar(ctx, key, handle);
  if (a.status === 'unknown') return hit || a;
  const doc = { _id: key, status: a.status, type: a.type || null, data: a.data || null, at: new Date() };
  await col.updateOne({ _id: key }, { $set: doc }, { upsert: true });
  return doc;
}

// keep listed accounts' names and follower counts fresh, a few per scheduler tick
export async function refreshProfiles(ctx, { batch = 5, maxAgeMs = 12 * 3600000 } = {}) {
  if (!ctx.cfg.profileUrl) return;
  const coins = await ctx.db.coins.find({ status: 'live', $or: [{ profileAt: { $exists: false } }, { profileAt: { $lt: new Date(Date.now() - maxAgeMs) } }] }).sort({ profileAt: 1 }).limit(batch).toArray();
  for (const c of coins) {
    await getProfile(ctx, c.key, c.handle, { maxAgeMs }).catch(() => null);
    await ctx.db.coins.updateOne({ mint: c.mint }, { $set: { profileAt: new Date() } });
  }
}
