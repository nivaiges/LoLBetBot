import { loadImage } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

// Lazily fetch ranked tier emblems from Community Dragon and cache them at
// assets/ranks/<tier>.png. Used by the rank ladder card.

const EMBLEM_DIR = path.resolve('assets', 'ranks');
const cache = new Map(); // tier (lowercase) → Image | false

function urlFor(tier) {
  // Community Dragon's stable path for ranked tier emblems.
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tier}.png`;
}

export async function getRankEmblem(tier) {
  if (!tier) return null;
  const key = String(tier).toLowerCase();
  if (cache.has(key)) {
    const v = cache.get(key);
    return v === false ? null : v;
  }

  const file = path.join(EMBLEM_DIR, `${key}.png`);
  if (existsSync(file)) {
    try {
      const img = await loadImage(file);
      cache.set(key, img);
      return img;
    } catch (err) {
      logger.warn({ err: err.message, tier: key }, 'rankEmblems: cached file unreadable');
    }
  }

  const url = urlFor(key);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(EMBLEM_DIR, { recursive: true });
    await writeFile(file, buf);
    const img = await loadImage(file);
    cache.set(key, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, tier: key, url }, 'rankEmblems: fetch failed');
    cache.set(key, false);
    return null;
  }
}

// Tight 80×80 mini-crest variants — already cropped to the crest shape with
// no wings or padding, so they look crisp at small icon sizes (e.g. inside
// the Match Detected tier pill). Emerald isn't part of the mini-crest set
// (predates the tier), so we fall back to a centered crop of the full wing
// emblem for that one tier — the renderer source-crops 60% on draw.
const MINI_DIR = path.resolve('assets', 'ranks-mini');
const miniCache = new Map();
const MINI_MISSING = new Set(['emerald']);

function miniUrlFor(tier) {
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${tier}.png`;
}

export async function getRankMiniCrest(tier) {
  if (!tier) return null;
  const key = String(tier).toLowerCase();
  if (MINI_MISSING.has(key)) return getRankEmblem(tier); // fall back to wing emblem
  if (miniCache.has(key)) {
    const v = miniCache.get(key);
    return v === false ? null : v;
  }

  const file = path.join(MINI_DIR, `${key}.png`);
  if (existsSync(file)) {
    try {
      const img = await loadImage(file);
      miniCache.set(key, img);
      return img;
    } catch (err) {
      logger.warn({ err: err.message, tier: key }, 'rankEmblems: cached mini-crest unreadable');
    }
  }

  const url = miniUrlFor(key);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(MINI_DIR, { recursive: true });
    await writeFile(file, buf);
    const img = await loadImage(file);
    miniCache.set(key, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, tier: key, url }, 'rankEmblems: mini-crest fetch failed, falling back to wing emblem');
    miniCache.set(key, false);
    return getRankEmblem(tier);
  }
}
