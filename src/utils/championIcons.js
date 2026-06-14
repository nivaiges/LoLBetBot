import { loadImage } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

// Lazily fetch champion square icons from Data Dragon and cache to
// assets/champions/<InternalName>.png. After first fetch they load from disk
// instantly. The internal name (e.g. "Naafiri", "MonkeyKing", "Nunu") is
// passed in by the caller — see the championId → internalId map in riot.js.

const ICON_DIR = path.resolve('assets', 'champions');

// internalName → loaded Image | false (false = tried, failed; skip retries)
const cache = new Map();
let ddragonVersion = null;

async function resolveVersion() {
  if (ddragonVersion) return ddragonVersion;
  try {
    const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    if (!res.ok) throw new Error(`versions HTTP ${res.status}`);
    const arr = await res.json();
    ddragonVersion = arr[0];
  } catch (err) {
    logger.warn({ err: err.message }, 'championIcons: failed to resolve DDragon version, using fallback');
    ddragonVersion = '16.10.1'; // last known good — bot will update on next restart if Data Dragon is reachable
  }
  return ddragonVersion;
}

export async function getChampionIcon(internalName) {
  if (!internalName) return null;
  if (cache.has(internalName)) {
    const v = cache.get(internalName);
    return v === false ? null : v;
  }

  const file = path.join(ICON_DIR, `${internalName}.png`);

  // Try cached file on disk first
  if (existsSync(file)) {
    try {
      const img = await loadImage(file);
      cache.set(internalName, img);
      return img;
    } catch (err) {
      logger.warn({ err: err.message, internalName }, 'championIcons: cached file failed to load, re-downloading');
    }
  }

  // Download from Data Dragon
  const ver = await resolveVersion();
  const url = `https://ddragon.leagueoflegends.com/cdn/${ver}/img/champion/${internalName}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(ICON_DIR, { recursive: true });
    await writeFile(file, buf);
    const img = await loadImage(file);
    cache.set(internalName, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, internalName, url }, 'championIcons: failed to fetch icon');
    cache.set(internalName, false);
    return null;
  }
}
