import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from './logger.js';

// Meraki Analytics publishes per-patch play-rate data for every champion across
// every role. We use it to infer who's playing what lane *before* the game
// starts (Match-V5 has the canonical `teamPosition` field, but it's only
// available after the game ends).
//
// Algorithm: try every permutation of 5 champions over 5 positions, pick the
// permutation that maximises Σ playRate(champion, position). With 5 slots
// that's 120 permutations — trivial cost. Mirrors meraki-analytics/role-identification.

const URL = 'https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/championrates.json';
const CACHE_FILE = path.resolve('data', 'championrates.json');
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

// championId (number) → { TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY } play rates
let playRates = null;

export async function loadPlayRates() {
  try {
    const res = await fetch(URL);
    if (res.ok) {
      const j = await res.json();
      const data = parseMerakiPayload(j);
      playRates = data;
      try {
        await mkdir(path.dirname(CACHE_FILE), { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(data));
      } catch (err) {
        logger.warn({ err: err.message }, 'laneInfer: failed to cache play rates to disk');
      }
      logger.info({ champions: Object.keys(data).length }, 'laneInfer: loaded champion play rates from Meraki CDN');
      return;
    }
    logger.warn({ status: res.status }, 'laneInfer: Meraki CDN returned non-OK, falling back to cache');
  } catch (err) {
    logger.warn({ err: err.message }, 'laneInfer: fetch failed, falling back to cache');
  }

  if (existsSync(CACHE_FILE)) {
    try {
      const j = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
      playRates = j;
      logger.info({ champions: Object.keys(j).length }, 'laneInfer: loaded play rates from disk cache');
      return;
    } catch (err) {
      logger.error({ err: err.message }, 'laneInfer: cache parse failed');
    }
  }

  logger.warn('laneInfer: no play-rate data available — lane inference will return null');
}

function parseMerakiPayload(j) {
  const out = {};
  for (const [championId, positions] of Object.entries(j.data || {})) {
    const id = parseInt(championId, 10);
    const rates = { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0 };
    for (const [pos, info] of Object.entries(positions || {})) {
      const key = pos.toUpperCase();
      if (key in rates) rates[key] = info?.playRate ?? 0;
    }
    out[id] = rates;
  }
  return out;
}

// Smite summoner spell ID. The matchmaker only allows it in the jungle slot,
// so whoever brought smite is the jungler with 100% certainty — we pin them
// to JUNGLE and let the play-rate optimizer fill the other four positions.
const SMITE_ID = 11;

function hasSmite(p) {
  return p?.spell1Id    === SMITE_ID || p?.spell2Id    === SMITE_ID
      || p?.summoner1Id === SMITE_ID || p?.summoner2Id === SMITE_ID;
}

// Input can be either:
//   - 5 numbers  (legacy: just champion IDs, no smite hint)
//   - 5 objects  ({ championId, spell1Id, spell2Id } from Spectator-V5, or
//                  { championId, summoner1Id, summoner2Id } from Match-V5)
// Returns: { TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY } → championId, or null.
export function inferLanes(participants) {
  if (!playRates || !Array.isArray(participants) || participants.length !== 5) return null;

  const isObject = typeof participants[0] === 'object' && participants[0] !== null;
  const champs = isObject ? participants.map(p => p.championId) : participants;

  // Smite hard-pin — only when caller passed participant objects. Lock that
  // champion into the JUNGLE slot; skip any permutation that violates it.
  let smiteChampId = null;
  if (isObject) {
    const smiter = participants.find(hasSmite);
    if (smiter) smiteChampId = smiter.championId;
  }

  let best = null;
  let bestScore = -Infinity;
  for (const perm of permute(champs)) {
    if (smiteChampId != null && perm[1] !== smiteChampId) continue;
    let score = 0;
    for (let i = 0; i < POSITIONS.length; i++) {
      score += playRates[perm[i]]?.[POSITIONS[i]] ?? 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = perm;
    }
  }
  if (!best) return null;
  return {
    TOP:     best[0],
    JUNGLE:  best[1],
    MIDDLE:  best[2],
    BOTTOM:  best[3],
    UTILITY: best[4],
  };
}

function* permute(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const sub of permute(rest)) yield [arr[i], ...sub];
  }
}

export function arePlayRatesLoaded() {
  return playRates !== null;
}
