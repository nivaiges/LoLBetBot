import { loadImage } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

// Lazily fetch League position icons from Community Dragon and cache to
// assets/lanes/<role>.png. Mirrors profileIcons.js / rankEmblems.js.
//
// Accepts the lane abbreviations the rest of the codebase uses (TOP/JNG/MID/
// BOT/SUP) and maps them onto Riot's CDN slug (top/jungle/middle/bottom/utility).

const ICON_DIR = path.resolve('assets', 'lanes');
const cache = new Map();

const ROLE_SLUG = {
  TOP: 'top',
  JNG: 'jungle',
  JUNGLE: 'jungle',
  MID: 'middle',
  MIDDLE: 'middle',
  BOT: 'bottom',
  ADC: 'bottom',
  BOTTOM: 'bottom',
  SUP: 'utility',
  SUPPORT: 'utility',
  UTILITY: 'utility',
};

export async function getLaneIcon(role) {
  if (!role) return null;
  const slug = ROLE_SLUG[String(role).toUpperCase()];
  if (!slug) return null;
  if (cache.has(slug)) {
    const v = cache.get(slug);
    return v === false ? null : v;
  }

  const file = path.join(ICON_DIR, `${slug}.png`);
  if (existsSync(file)) {
    try {
      const img = await loadImage(file);
      cache.set(slug, img);
      return img;
    } catch (err) {
      logger.warn({ err: err.message, slug }, 'laneIcons: cached file unreadable');
    }
  }

  const url = `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${slug}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(ICON_DIR, { recursive: true });
    await writeFile(file, buf);
    const img = await loadImage(file);
    cache.set(slug, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, slug, url }, 'laneIcons: fetch failed');
    cache.set(slug, false);
    return null;
  }
}
