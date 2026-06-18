import { loadImage } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

// Lazily fetch Riot summoner profile icons from Data Dragon and cache to
// assets/profile-icons/<id>.png. Mirrors championIcons.js.

const ICON_DIR = path.resolve('assets', 'profile-icons');
const cache = new Map(); // id → Image | false (false = tried, failed)
let ddragonVersion = null;

async function resolveVersion() {
  if (ddragonVersion) return ddragonVersion;
  try {
    const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    ddragonVersion = arr[0];
  } catch (err) {
    logger.warn({ err: err.message }, 'profileIcons: DDragon version fetch failed, using fallback');
    ddragonVersion = '16.10.1';
  }
  return ddragonVersion;
}

export async function getProfileIcon(profileIconId) {
  if (profileIconId == null) return null;
  if (cache.has(profileIconId)) {
    const v = cache.get(profileIconId);
    return v === false ? null : v;
  }

  const file = path.join(ICON_DIR, `${profileIconId}.png`);
  if (existsSync(file)) {
    try {
      const img = await loadImage(file);
      cache.set(profileIconId, img);
      return img;
    } catch (err) {
      logger.warn({ err: err.message, profileIconId }, 'profileIcons: cached file unreadable');
    }
  }

  const ver = await resolveVersion();
  const url = `https://ddragon.leagueoflegends.com/cdn/${ver}/img/profileicon/${profileIconId}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(ICON_DIR, { recursive: true });
    await writeFile(file, buf);
    const img = await loadImage(file);
    cache.set(profileIconId, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, profileIconId, url }, 'profileIcons: fetch failed');
    cache.set(profileIconId, false);
    return null;
  }
}
