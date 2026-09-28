// Coin metadata for pump.fun. Default: upload to pump.fun's IPFS (where pump.fun's own site stores it).
// METADATA_MODE=self serves it from this server instead (used by the local simulator and tests).
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { isAbsolute, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let imageCache = null;
function coinImage(cfg) {
  if (!imageCache) imageCache = readFileSync(isAbsolute(cfg.coinImage) ? cfg.coinImage : join(ROOT, cfg.coinImage));
  return imageCache;
}

export async function uploadCoinMetadata(ctx, { name, symbol, website }) {
  const { cfg, db } = ctx;
  const img = coinImage(cfg);
  if (cfg.metadataMode === 'self') {
    const id = randomUUID();
    const base = cfg.publicUrl || `http://127.0.0.1:${cfg.port}`;
    const image = `${base}/media/${id}`;
    const meta = { name, symbol, description: '', image, showName: true, website };
    await db.db.collection('media').insertOne({ _id: id, type: 'image/png', data: img, meta, createdAt: new Date() });
    return { uri: `${base}/meta/${id}.json`, image };
  }
  const form = new FormData();
  form.append('file', new Blob([img], { type: 'image/png' }), 'coin.png');
  form.append('name', name); form.append('symbol', symbol); form.append('description', '');
  if (website) form.append('website', website);
  form.append('showName', 'true');
  const r = await fetch(cfg.pumpIpfsUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error('Could not prepare the listing. Try again.'), { status: 502 });
  const j = await r.json();
  return { uri: j.metadataUri, image: j.metadata?.image };
}
