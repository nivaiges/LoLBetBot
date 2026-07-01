import { loadImage } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

// Lazily fetch item icons from Data Dragon and cache to assets/items/<id>.png.
// Mirrors profileIcons.js / championIcons.js. Riot's `participant.itemN` field
// is 0 when the slot is empty, which we treat as "no icon" — the renderer
// draws a placeholder for those.

const ITEM_DIR = path.resolve('assets', 'items');
const cache = new Map();
let ddragonVersion = null;

async function resolveVersion() {
  if (ddragonVersion) return ddragonVersion;
  try {
    const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    ddragonVersion = arr[0];
  } catch (err) {
    logger.warn({ err: err.message }, 'itemIcons: DDragon version fetch failed, using fallback');
    ddragonVersion = '16.10.1';
  }
  return ddragonVersion;
}

export async function getItemIcon(itemId) {
  if (!itemId || itemId === 0) return null;
  if (cache.has(itemId)) {
    const v = cache.get(itemId);
    return v === false ? null : v;
  }

  const file = path.join(ITEM_DIR, `${itemId}.png`);
  if (existsSync(file)) {
    try {
      const img = await loadImage(file);
      cache.set(itemId, img);
      return img;
    } catch (err) {
      logger.warn({ err: err.message, itemId }, 'itemIcons: cached file unreadable');
    }
  }

  const ver = await resolveVersion();
  const url = `https://ddragon.leagueoflegends.com/cdn/${ver}/img/item/${itemId}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(ITEM_DIR, { recursive: true });
    await writeFile(file, buf);
    const img = await loadImage(file);
    cache.set(itemId, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, itemId, url }, 'itemIcons: fetch failed');
    cache.set(itemId, false);
    return null;
  }
}
