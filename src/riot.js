import config from '../config.js';
import logger from './utils/logger.js';

const RIOT_KEY = process.env.RIOT_API_KEY;

// ── Data Dragon: champion ID → name mapping ─────────────────────────────────
// Two maps: display names (e.g. "Nunu & Willump") and internal IDs (e.g.
// "Nunu") — the latter is what Data Dragon uses in image URLs.
let championMap = null;        // numeric ID → display name
let championInternalMap = null; // numeric ID → internal ID (image URL slug)

export async function loadChampionMap() {
  if (championMap) return;
  try {
    const verRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    const versions = await verRes.json();
    const latest = versions[0];
    const champRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`);
    const champData = await champRes.json();
    championMap = {};
    championInternalMap = {};
    for (const champ of Object.values(champData.data)) {
      const numeric = parseInt(champ.key);
      championMap[numeric] = champ.name;
      championInternalMap[numeric] = champ.id;
    }
    logger.info({ version: latest, count: Object.keys(championMap).length }, 'Loaded champion data from Data Dragon');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to load champion data from Data Dragon');
    championMap = {};
    championInternalMap = {};
  }
}

export function getChampionName(championId) {
  if (!championMap) return `Champ ${championId}`;
  return championMap[championId] || `Champ ${championId}`;
}

// Internal ID used in Data Dragon asset URLs (e.g. "Nunu" not "Nunu & Willump").
export function getChampionInternalId(championId) {
  return championInternalMap?.[championId] || null;
}

async function riotFetch(url) {
  logger.debug({ url }, 'Riot API request');
  let res;
  try {
    res = await fetch(url, {
      headers: { 'X-Riot-Token': RIOT_KEY },
    });
  } catch (err) {
    logger.error({ err: err.message, url }, 'Riot API network error');
    return null;
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || '10';
    logger.warn({ retryAfter }, 'Riot API rate limited, backing off');
    return { rateLimited: true, retryAfter: parseInt(retryAfter, 10) };
  }

  if (res.status === 403) {
    logger.warn({ url }, 'Riot API 403 Forbidden (likely custom game)');
    return { forbidden: true };
  }

  if (res.status === 404) {
    return null; // Not found is a normal response (e.g. player not in game)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, url, body }, 'Riot API error');
    return null;
  }

  return res.json();
}

// Like riotFetch but preserves error distinction (404 vs 5xx vs network).
// Returns one of: parsed JSON | { notFound: true } | { rateLimited, retryAfter } | { forbidden: true } | { httpError: status } | { networkError: message }
async function riotFetchDetailed(url) {
  logger.debug({ url }, 'Riot API request (detailed)');
  let res;
  try {
    res = await fetch(url, { headers: { 'X-Riot-Token': RIOT_KEY } });
  } catch (err) {
    logger.error({ err: err.message, url }, 'Riot API network error');
    return { networkError: err.message };
  }
  if (res.status === 404) return { notFound: true };
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || '10';
    return { rateLimited: true, retryAfter: parseInt(retryAfter, 10) };
  }
  if (res.status === 403) return { forbidden: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, url, body }, 'Riot API error');
    return { httpError: res.status };
  }
  return res.json();
}

/**
 * Resolve a Riot ID (gameName#tagLine) to a PUUID.
 * Uses the Account-V1 regional endpoint.
 */
export async function getAccountByRiotId(gameName, tagLine, platform) {
  const base = config.regionalUrl(platform || config.riotRegion);
  return riotFetch(`${base}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
}

/**
 * Check if a player is currently in an active game.
 * Uses Spectator-V5 on the platform endpoint.
 */
export async function getActiveGame(puuid, platform) {
  const base = config.platformUrl(platform || config.riotRegion);
  return riotFetchDetailed(`${base}/lol/spectator/v5/active-games/by-summoner/${puuid}`);
}

/**
 * Fetch a completed match by match ID.
 * Uses Match-V5 on the regional endpoint.
 */
export async function getMatchResult(matchId, platform) {
  const base = config.regionalUrl(platform || config.riotRegion);
  return riotFetch(`${base}/lol/match/v5/matches/${matchId}`);
}

/**
 * Fetch the per-minute timeline for a completed match.
 * Returns frames with participantFrames containing totalGold/xp/level/etc.
 */
export async function getMatchTimeline(matchId, platform) {
  const base = config.regionalUrl(platform || config.riotRegion);
  return riotFetch(`${base}/lol/match/v5/matches/${matchId}/timeline`);
}

/**
 * Get ranked stats (Solo/Duo) for a summoner.
 * Uses League-V4 on the platform endpoint.
 * Requires summoner ID, which we derive from PUUID first.
 */
export async function getSummonerByPuuid(puuid, platform) {
  const base = config.platformUrl(platform || config.riotRegion);
  return riotFetch(`${base}/lol/summoner/v4/summoners/by-puuid/${puuid}`);
}

export async function getRankedStats(summonerId, platform) {
  const base = config.platformUrl(platform || config.riotRegion);
  return riotFetch(`${base}/lol/league/v4/entries/by-summoner/${summonerId}`);
}

export async function getRankedStatsByPuuid(puuid, platform) {
  const base = config.platformUrl(platform || config.riotRegion);
  return riotFetch(`${base}/lol/league/v4/entries/by-puuid/${puuid}`);
}
