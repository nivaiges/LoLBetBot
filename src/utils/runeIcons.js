import { loadImage } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

// Fetches summoner-spell + rune icons from Community Dragon and caches them
// on disk. Riot embeds the canonical icon path in their JSON manifests
// (perks.json, perkstyles.json, summoner-spells.json), so we lazy-load
// those manifests once per process, look up the path by ID, then convert
// to a Community Dragon URL.

const SPELL_DIR = path.resolve('assets', 'summoner-spells');
const RUNE_DIR  = path.resolve('assets', 'runes');

const spellMap = new Map();   // id → iconPath (from summoner-spells.json)
const perkMap  = new Map();   // id → iconPath (from perks.json)
const styleMap = new Map();   // id → iconPath (from perkstyles.json)
const spellImgCache = new Map(); // id → Image | false
const perkImgCache  = new Map();
const styleImgCache = new Map();

let manifestsLoaded = null; // Promise

// Convert a Riot iconPath like
//   "/lol-game-data/assets/v1/perk-images/Styles/Precision/Conqueror/Conqueror.png"
// to a Community Dragon URL. CDragon serves under the lowercased path.
function cdragonUrl(iconPath) {
  const stripped = iconPath.toLowerCase().replace('/lol-game-data/assets', '');
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default${stripped}`;
}

async function loadManifests() {
  if (manifestsLoaded) return manifestsLoaded;
  manifestsLoaded = (async () => {
    try {
      const [spells, perks, styles] = await Promise.all([
        fetch('https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/summoner-spells.json').then(r => r.json()),
        fetch('https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perks.json').then(r => r.json()),
        fetch('https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perkstyles.json').then(r => r.json()),
      ]);
      for (const s of spells || []) spellMap.set(s.id, s.iconPath);
      for (const p of perks  || []) perkMap.set(p.id, p.iconPath);
      for (const s of (styles?.styles || [])) styleMap.set(s.id, s.iconPath);
      logger.info({ spells: spellMap.size, perks: perkMap.size, styles: styleMap.size }, 'Loaded Riot asset manifests');
    } catch (err) {
      logger.warn({ err: err.message }, 'runeIcons: failed to load manifests');
    }
  })();
  return manifestsLoaded;
}

async function fetchAndCache(url, file, dir, memCache, key) {
  if (memCache.has(key)) {
    const v = memCache.get(key);
    return v === false ? null : v;
  }
  if (existsSync(file)) {
    try {
      const img = await loadImage(file);
      memCache.set(key, img);
      return img;
    } catch (err) {
      logger.warn({ err: err.message, file }, 'runeIcons: cached file unreadable');
    }
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dir, { recursive: true });
    await writeFile(file, buf);
    const img = await loadImage(file);
    memCache.set(key, img);
    return img;
  } catch (err) {
    logger.warn({ err: err.message, url }, 'runeIcons: fetch failed');
    memCache.set(key, false);
    return null;
  }
}

export async function getSummonerSpellIcon(id) {
  if (!id) return null;
  await loadManifests();
  const iconPath = spellMap.get(id);
  if (!iconPath) return null;
  // Riot's summoner-spell iconPath has mixed casing; pull just the filename
  // and use it as the cache key so capital/lowercase variants don't double-cache.
  const file = path.join(SPELL_DIR, `${id}.png`);
  return fetchAndCache(cdragonUrl(iconPath), file, SPELL_DIR, spellImgCache, id);
}

export async function getRuneIcon(perkId) {
  if (!perkId) return null;
  await loadManifests();
  const iconPath = perkMap.get(perkId);
  if (!iconPath) return null;
  const file = path.join(RUNE_DIR, `perk-${perkId}.png`);
  return fetchAndCache(cdragonUrl(iconPath), file, RUNE_DIR, perkImgCache, perkId);
}

export async function getRuneStyleIcon(styleId) {
  if (!styleId) return null;
  await loadManifests();
  const iconPath = styleMap.get(styleId);
  if (!iconPath) return null;
  const file = path.join(RUNE_DIR, `style-${styleId}.png`);
  return fetchAndCache(cdragonUrl(iconPath), file, RUNE_DIR, styleImgCache, `style-${styleId}`);
}
