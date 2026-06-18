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

// ── Rate-limit + concurrency control ────────────────────────────────────────
// Personal-tier Riot keys cap at 20 req/s and 100 req/2 min. We stay under
// the per-second ceiling with a semaphore + auto-retry on 429. A shared
// cooldown short-circuits new requests while Riot is throttling us, so a
// single 429 doesn't snowball into a queue of retries that dig the hole
// deeper.

const MAX_CONCURRENT = 10;
const MAX_RETRIES = 2;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.max) { this.active++; return; }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}
const riotSemaphore = new Semaphore(MAX_CONCURRENT);

let globalRiotCooldownUntil = 0;
function engageRiotCooldown(seconds) {
  const until = Date.now() + Math.max(1, seconds) * 1000;
  if (until > globalRiotCooldownUntil) {
    globalRiotCooldownUntil = until;
    logger.warn({ seconds }, 'Riot API global cooldown engaged');
  }
}

// Public: how many seconds until callers can hit Riot again. Returns
// { cooling: false, secondsLeft: 0 } when we're not throttled.
export function getRiotCooldown() {
  const left = Math.max(0, Math.ceil((globalRiotCooldownUntil - Date.now()) / 1000));
  return { cooling: left > 0, secondsLeft: left };
}

// Public: canonical user-facing message for any command that hit a Riot
// rate-limit marker. Keeps the wording consistent across slash commands.
export function riotRateLimitMessage() {
  const { secondsLeft } = getRiotCooldown();
  const s = secondsLeft > 0 ? secondsLeft : 10;
  return `⏳ Riot API is rate-limiting us right now. Please try again in **${s}s**.`;
}

// Helper: do the actual HTTP request, retrying once on 429.
// Returns one of:
//   { ok: true, data }      — request succeeded
//   { rateLimited, retryAfter }
//   { forbidden: true }     — 403
//   { notFound: true }      — 404
//   { httpError: status }   — other non-2xx
//   { networkError: msg }   — fetch threw
async function riotFetchCore(url) {
  // Short-circuit if Riot recently 429'd. Skip the semaphore acquire entirely
  // so we don't even queue up requests during cooldown.
  if (Date.now() < globalRiotCooldownUntil) {
    return { rateLimited: true, retryAfter: getRiotCooldown().secondsLeft };
  }

  await riotSemaphore.acquire();
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      logger.debug({ url, attempt }, 'Riot API request');
      let res;
      try {
        res = await fetch(url, { headers: { 'X-Riot-Token': RIOT_KEY } });
      } catch (err) {
        logger.error({ err: err.message, url }, 'Riot API network error');
        return { networkError: err.message };
      }

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '10', 10);
        engageRiotCooldown(retryAfter);
        // Auto-retry once after sleeping the Retry-After window. Skip the
        // retry on the final attempt — that's when we hand control back to
        // the caller with a rateLimited marker.
        if (attempt < MAX_RETRIES) {
          logger.warn({ retryAfter, attempt, url }, 'Riot API 429, retrying');
          await sleep(retryAfter * 1000);
          continue;
        }
        return { rateLimited: true, retryAfter };
      }
      if (res.status === 403) {
        logger.warn({ url }, 'Riot API 403 Forbidden (likely custom game)');
        return { forbidden: true };
      }
      if (res.status === 404) return { notFound: true };
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.error({ status: res.status, url, body }, 'Riot API error');
        return { httpError: res.status };
      }
      const data = await res.json();
      return { ok: true, data };
    }
    // Unreachable — the loop always returns inside.
    return { httpError: 0 };
  } finally {
    riotSemaphore.release();
  }
}

// Public wrapper: collapses error shapes into "data | null | marker". Keeps
// existing callers working — 404/5xx/network → null, 429/403 surface their
// markers, success returns the JSON directly.
async function riotFetch(url) {
  const r = await riotFetchCore(url);
  if (r.ok) return r.data;
  if (r.rateLimited) return { rateLimited: true, retryAfter: r.retryAfter };
  if (r.forbidden) return { forbidden: true };
  return null;
}

// Like riotFetch but preserves error distinction (404 vs 5xx vs network).
// Returns one of: parsed JSON | { notFound: true } | { rateLimited, retryAfter } | { forbidden: true } | { httpError: status } | { networkError: message }
async function riotFetchDetailed(url) {
  const r = await riotFetchCore(url);
  if (r.ok) return r.data;
  if (r.notFound) return { notFound: true };
  if (r.rateLimited) return { rateLimited: true, retryAfter: r.retryAfter };
  if (r.forbidden) return { forbidden: true };
  if (r.httpError != null) return { httpError: r.httpError };
  if (r.networkError) return { networkError: r.networkError };
  return null;
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

// Top champion ID (by mastery points) for a player. Cached for 1 hour per
// (region, puuid) — top champ only changes when the player builds a lot of
// new mastery on something else, which is slow at the timescales we care
// about. Returns null on miss / failure.
const TOP_CHAMP_TTL_MS = 60 * 60 * 1000;
const topChampCache = new Map(); // `${region}:${puuid}` → { fetchedAt, championId }

export async function getTopChampion(puuid, platform) {
  const region = (platform || config.riotRegion).toLowerCase();
  const cacheKey = `${region}:${puuid}`;
  const cached = topChampCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TOP_CHAMP_TTL_MS) return cached.championId;

  const base = config.platformUrl(platform || config.riotRegion);
  const data = await riotFetch(`${base}/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=1`);
  if (!Array.isArray(data) || !data.length) {
    if (cached) return cached.championId; // serve stale on failure
    return null;
  }
  const championId = data[0].championId;
  topChampCache.set(cacheKey, { fetchedAt: Date.now(), championId });
  return championId;
}

// Apex-tier LP cutoffs per region. Riot allocates Master/GM/Challenger by
// rank across the combined apex pool — top 300 are Challenger, next 700 are
// Grandmaster, everyone else above Diamond I is Master. The "lowest LP in
// GM" we get from the GM endpoint alone counts decayed (inactive) players
// that fell below the actual promotion threshold, so we instead:
//   1. Fetch all three apex ladders (Master ~9.5k, GM ~700, CHL ~300 entries)
//   2. Combine + sort by LP descending
//   3. CHL cutoff  = LP of the 300th-highest player
//   4. GM  cutoff  = LP of the 1000th-highest player
// Cached for 6h — these endpoints together pull ~2 MB so we keep them rare.
const CUTOFF_TTL_MS = 6 * 60 * 60 * 1000;
const CHL_SLOTS = 300;
const GM_SLOTS = 700;
const apexCutoffCache = new Map(); // region → { fetchedAt, gm, chl }

export async function getApexCutoffs(platform) {
  const region = (platform || config.riotRegion).toLowerCase();
  const cached = apexCutoffCache.get(region);
  if (cached && Date.now() - cached.fetchedAt < CUTOFF_TTL_MS) return cached;

  const base = config.platformUrl(platform || config.riotRegion);
  try {
    const [mRes, gmRes, chlRes] = await Promise.all([
      riotFetch(`${base}/lol/league/v4/masterleagues/by-queue/RANKED_SOLO_5x5`),
      riotFetch(`${base}/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5`),
      riotFetch(`${base}/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5`),
    ]);

    // If any call got rate-limited or failed, don't poison the cache with
    // bad cutoffs — return stale value if we have one, else nulls.
    if (mRes?.rateLimited || gmRes?.rateLimited || chlRes?.rateLimited
        || !mRes?.entries || !gmRes?.entries || !chlRes?.entries) {
      if (cached) return cached;
      return { fetchedAt: Date.now(), gm: null, chl: null };
    }

    const all = [
      ...(mRes?.entries || []),
      ...(gmRes?.entries || []),
      ...(chlRes?.entries || []),
    ].sort((a, b) => b.leaguePoints - a.leaguePoints);

    // If a region has fewer apex players than the slot count (off-server), the
    // cutoff falls back to the lowest LP in that pool — at that point everyone
    // qualifies. Won't realistically happen on NA/EUW/KR but keeps logic safe.
    const chlCutoff = all.length >= CHL_SLOTS
      ? all[CHL_SLOTS - 1].leaguePoints
      : (all[all.length - 1]?.leaguePoints ?? null);
    const gmCutoff = all.length >= CHL_SLOTS + GM_SLOTS
      ? all[CHL_SLOTS + GM_SLOTS - 1].leaguePoints
      : (all[all.length - 1]?.leaguePoints ?? null);

    const result = {
      fetchedAt: Date.now(),
      gm: gmCutoff,
      chl: chlCutoff,
    };
    apexCutoffCache.set(region, result);
    return result;
  } catch (err) {
    logger.warn({ err: err.message, region }, 'getApexCutoffs failed');
    if (cached) return cached; // serve stale on transient failure
    return { fetchedAt: Date.now(), gm: null, chl: null };
  }
}
