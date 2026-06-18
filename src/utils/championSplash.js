import { loadImage } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

// Lazily fetch *centered* champion splash art from Community Dragon and
// cache to assets/splash/<InternalId>.jpg. Used as a faded background on the
// Match Over recap. We prefer the centered variant over the raw splash —
// raw splashes have wildly inconsistent composition (face on the left, far
// right, etc.), so a center-cropped cover-fit would clip the head off some
// champions. Community Dragon's "centered" version puts the champion's
// face/upper body in the frame center for every champ.

const SPLASH_DIR = path.resolve('assets', 'splash');
const cache = new Map(); // internalId → Image | false

export async function getChampionSplash(internalId) {
  if (!internalId) return null;
  if (cache.has(internalId)) {
    const v = cache.get(internalId);
    return v === false ? null : v;
  }

  const file = path.join(SPLASH_DIR, `${internalId}.jpg`);
  if (existsSync(file)) {
    try {
      const img = await loadImage(file);
      cache.set(internalId, img);
      return img;
    } catch (err) {
      logger.warn({ err: err.message, internalId }, 'championSplash: cached file unreadable');
    }
  }

  const url = `https://cdn.communitydragon.org/latest/champion/${internalId}/splash-art/centered`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(SPLASH_DIR, { recursive: true });
    await writeFile(file, buf);
    const img = await loadImage(file);
    cache.set(internalId, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, internalId, url }, 'championSplash: fetch failed');
    cache.set(internalId, false);
    return null;
  }
}
