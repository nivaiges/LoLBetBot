import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import config from '../config.js';
import logger from './utils/logger.js';
import { fileLog } from './utils/fileLog.js';
import { peakLog } from './utils/peakLog.js';
import { getActiveGame, getMatchResult, getMatchTimeline, getRankedStatsByPuuid, loadChampionMap, getChampionName, getChampionInternalId } from './riot.js';
import { computeTeamGoldLead, extractObjectiveEvents, computeWonLane, extractTrackedPlayerKills, renderTeamsCompositePng, renderMatchOverPng, renderMatchOverScoreboardPng, renderMatchOverImpactPng } from './matchGraph.js';
import { loadPlayRates, inferLanes } from './utils/laneInfer.js';
import { registerBettingWindow } from './utils/bettingwindow.js';
import {
  getAllTrackedPlayers,
  upsertActiveMatch,
  getAllActiveMatches,
  markMatchFinished,
  markMatchCancelled,
  cancelUnresolvedBets,
  getUnresolvedBetsByMatch,
  resolveBet,
  updateUserStats,
  touchMatch,
  getGuildChannel,
  isAutoDeleteEnabled,
  setMatchParlay,
  getMatchParlay,
  getUnresolvedParleyBetsByMatch,
  resolveParleyBet,
  setMatchMessageIdForAllInMatch,
  setMatchCloseMessageId,
  getMatchMessages,
  recordDailyResult,
  getDailyRecord,
  updatePeakRank,
  recordLp,
  recordLaneResult,
  getAutoBetsForMatch,
  setLastMatchOverMessage,
  getLastMatchOverMessage,
  clearLastMatchOverMessage,
  getActiveMatchExtraMessages,
  ensureUser,
  getUser,
  getUserBetOnMatch,
  deductCoins,
  placeBet,
  isEmojiEnabled,
  checkAchievements,
  recordDuoResult,
  addCoins,
  getOpenPredict10ForPlayer,
  updatePredict10Progress,
  settlePredict10,
} from './db.js';

let client = null;
let pollTimer = null;
let tickInProgress = false;

// u.gg multisearch URL per matchId — reused by closeBetting so the message
// keeps a single u.gg button after the betting buttons are stripped.
const uggUrlByMatch = new Map();

export async function startPoller(discordClient) {
  client = discordClient;
  await loadChampionMap();
  await loadPlayRates(); // Meraki play-rate data for lane inference
  logger.info({ intervalMs: config.pollIntervalMs }, 'Starting match poller');
  pollTimer = setInterval(pollTick, config.pollIntervalMs);
  pollTick();
}

export function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollTick() {
  if (tickInProgress) {
    logger.debug('Skipping poll tick — previous tick still running');
    return;
  }
  tickInProgress = true;
  try {
    await checkForNewMatches();
    await checkActiveMatches();
  } catch (err) {
    logger.error({ err }, 'Poller tick error');
  } finally {
    tickInProgress = false;
  }
}

function getDisplayName(riotTag) {
  const name = riotTag.split('#')[0];
  if (!name) return name;
  const c = name[0];
  if (c >= 'a' && c <= 'z') return c.toUpperCase() + name.slice(1);
  return name;
}

// Resolve a Discord user ID to a readable name for rendered images (where
// <@id> mentions don't work). Tries the guild member cache, then the user
// cache, then falls back to a short form of the ID.
async function resolveDiscordName(guildId, discordId) {
  if (discordId === HOUSE_ID) return HOUSE_LABEL;
  try {
    const guild = client?.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(discordId) || (guild ? await guild.members.fetch(discordId).catch(() => null) : null);
    if (member) return member.displayName;
    const user = client?.users.cache.get(discordId);
    if (user) return user.username;
  } catch { /* fall through */ }
  return 'Someone';
}

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVISIONS = ['IV', 'III', 'II', 'I'];

// Spectator-V5 gameQueueConfigId → readable name for the Match Detected header.
const QUEUE_NAMES = {
  400: 'Normal Draft',
  420: 'Ranked Solo/Duo',
  430: 'Normal Blind',
  440: 'Ranked Flex',
  450: 'ARAM',
  490: 'Quickplay',
  700: 'Clash',
  720: 'ARAM Clash',
  830: 'Co-op vs AI',
  840: 'Co-op vs AI',
  850: 'Co-op vs AI',
  900: 'ARURF',
  1020: 'One for All',
  1700: 'Arena',
  1900: 'URF',
};
function queueName(game) {
  return QUEUE_NAMES[game?.gameQueueConfigId] || game?.gameMode || 'Custom';
}

// Queue IDs the bot DOESN'T post Match Detected for at all (fully silent).
const SKIP_QUEUES = new Set([
  1700, // Arena
  830, 840, 850, // Co-op vs AI
]);

// Queue IDs that produce a full Match Over recap when they end. Anything
// detected but NOT in this allowlist (e.g. the new ranked-5s mode) still
// posts Match Detected so people see the game starting, but at match end
// the result is silently cancelled — Match Detected gets deleted, any bets
// refunded, no Match Over post.
const TRACKED_QUEUES = new Set([
  400,  // Normal Draft
  420,  // Ranked Solo/Duo
  430,  // Normal Blind
  440,  // Ranked Flex
  450,  // ARAM
  490,  // Quickplay
  700,  // Clash
  720,  // ARAM Clash
  900,  // ARURF
  1020, // One for All
  1900, // URF
]);

// Parlay pool. Each leg has:
//   stat   — settlement key (matches the participant field or our derived
//            metric in computeParlayValue below)
//   label  — short human string for the modal + image
//   type   — 'yesno' (line=0.5) or 'ou' (random line picked from min..max
//            stepped by `step`)
//   min/max/step — default O/U line range (used when no role override)
//   onlyRoles    — leg only generated for these roles (TOP/JUNGLE/MIDDLE/
//                  BOTTOM/UTILITY)
//   excludeRoles — leg never generated for these roles
//   roleLines    — per-role override of min/max/step so the line is tuned
//                  to what's realistic (e.g. supports place way more wards
//                  than ADCs, so their wards-placed range is higher)
const PARLEY_POOL = [
  // ── Universal — works for every role ─────────────────────────────────
  { stat: 'won',           label: 'Win',                type: 'yesno' },
  { stat: 'wonLane',       label: 'Won Lane',           type: 'yesno' },
  { stat: 'firstBlood',    label: 'First Blood',        type: 'yesno' },
  { stat: 'gameLength',    label: 'Game Length (min)',  type: 'ou', min: 22.5, max: 35.5, step: 1 },
  { stat: 'deaths',        label: 'Deaths',             type: 'ou', min: 2.5,  max: 6.5,  step: 1 },
  { stat: 'kda',           label: 'KDA',                type: 'ou', min: 1.5,  max: 4.5,  step: 0.5 },

  // ── Combat — supports usually don't carry kills, exclude them ──────
  { stat: 'kills',         label: 'Kills',              type: 'ou', min: 3.5, max: 8.5, step: 1,
    excludeRoles: ['UTILITY'],
    roleLines: { JUNGLE: { min: 4.5, max: 10.5, step: 1 } },
  },
  { stat: 'tripleKill',    label: 'Triple Kill',        type: 'yesno', excludeRoles: ['UTILITY'] },
  { stat: 'multiKill',     label: 'Quadra/Penta',       type: 'yesno', excludeRoles: ['UTILITY'] },

  // ── Playmaking — supports/junglers get more ─────────────────────────
  { stat: 'assists',       label: 'Assists',            type: 'ou', min: 5.5, max: 14.5, step: 1,
    roleLines: { UTILITY: { min: 9.5, max: 20.5, step: 1 }, JUNGLE: { min: 7.5, max: 16.5, step: 1 } },
  },
  { stat: 'killParticipation', label: 'Kill Participation %', type: 'ou', min: 40, max: 75, step: 5,
    roleLines: { UTILITY: { min: 50, max: 80, step: 5 }, JUNGLE: { min: 50, max: 80, step: 5 } },
  },

  // ── Farming — only roles that farm primary minion wave ──────────────
  { stat: 'cs',            label: 'CS',                 type: 'ou', min: 120.5, max: 220.5, step: 10,
    onlyRoles: ['TOP', 'MIDDLE', 'BOTTOM', 'JUNGLE'],
    roleLines: { JUNGLE: { min: 100.5, max: 180.5, step: 10 } },
  },

  // ── Economy ─────────────────────────────────────────────────────────
  { stat: 'goldEarned',    label: 'Gold (k)',           type: 'ou', min: 8.5, max: 16.5, step: 1,
    roleLines: { UTILITY: { min: 7.5, max: 12.5, step: 0.5 } },
  },
  { stat: 'damageDealt',   label: 'Damage Dealt (k)',   type: 'ou', min: 12, max: 28, step: 2,
    excludeRoles: ['UTILITY'], // supports rarely deal heavy champion damage
  },
  { stat: 'damageTaken',   label: 'Damage Taken (k)',   type: 'ou', min: 15, max: 35, step: 2,
    onlyRoles: ['TOP', 'JUNGLE'], // tanks/bruisers take the most
  },

  // ── Vision ──────────────────────────────────────────────────────────
  { stat: 'visionScore',   label: 'Vision Score',       type: 'ou', min: 15.5, max: 40.5, step: 5,
    roleLines: { UTILITY: { min: 30.5, max: 65.5, step: 5 } },
  },
  { stat: 'wardsPlaced',   label: 'Wards Placed',       type: 'ou', min: 8.5, max: 18.5, step: 2,
    roleLines: { UTILITY: { min: 14.5, max: 30.5, step: 2 } },
  },
  { stat: 'wardsKilled',   label: 'Wards Killed',       type: 'ou', min: 2.5, max: 6.5, step: 1,
    roleLines: { UTILITY: { min: 3.5, max: 9.5, step: 1 } },
  },
];

const YES_NO_STATS = new Set(PARLEY_POOL.filter(p => p.type === 'yesno').map(p => p.stat));
const PARLEY_LABELS = Object.fromEntries(PARLEY_POOL.map(p => [p.stat, p.label]));

// Pick `count` random legs from the pool, filtered by the tracked player's
// role. Each picked leg gets a random O/U line drawn from the role-tuned
// range (falls back to the leg's default min/max/step when no role override
// exists). Yes/no legs always get line 0.5.
function pickParlayLegsForRole(role, count) {
  const eligible = PARLEY_POOL.filter(leg => {
    if (leg.onlyRoles && !leg.onlyRoles.includes(role)) return false;
    if (leg.excludeRoles && leg.excludeRoles.includes(role)) return false;
    return true;
  });
  const shuffled = [...eligible].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count).map(pick => {
    let line;
    if (pick.type === 'yesno') {
      line = 0.5;
    } else {
      const tuned = (pick.roleLines && pick.roleLines[role]) || pick;
      const steps = Math.round((tuned.max - tuned.min) / tuned.step);
      line = tuned.min + Math.floor(Math.random() * (steps + 1)) * tuned.step;
    }
    return { stat: pick.stat, label: pick.label, type: pick.type, line };
  });
}

function rankToValue(tier, division) {
  const tierIdx = TIERS.indexOf(tier);
  if (tierIdx < 0) return null;
  if (tierIdx >= 7) return tierIdx * 4; // MASTER+ have no divisions
  return tierIdx * 4 + DIVISIONS.indexOf(division);
}

// "The House" — automated bettor. Logistic rank-skill model; bets only when
// confidence is past config.house.edgeThreshold. Config in config.js.
const HOUSE_ID = config.house.id;
const HOUSE_LABEL = config.house.label;
const HOUSE_BET = config.house.bet;
const HOUSE_TOPUP_TO = config.house.topupTo;
const UNRANKED_SKILL = 14;

function computeHouseBet(participants, trackedTeamId) {
  const skill = (p) => {
    const v = rankToValue(p.tier, p.rank);
    return v == null ? UNRANKED_SKILL : v;
  };
  const blue = participants.filter(p => p.teamId === 100);
  const red = participants.filter(p => p.teamId === 200);
  if (blue.length === 0 || red.length === 0) return null;
  const blueAvg = blue.reduce((s, p) => s + skill(p), 0) / blue.length;
  const redAvg = red.reduce((s, p) => s + skill(p), 0) / red.length;
  const trackedAvg = trackedTeamId === 100 ? blueAvg : redAvg;
  const enemyAvg = trackedTeamId === 100 ? redAvg : blueAvg;
  const pWin = 1 / (1 + Math.exp(-0.15 * (trackedAvg - enemyAvg)));
  const t = config.house.edgeThreshold;
  if (pWin >= t) return { prediction: 'win', confidence: pWin };
  if (pWin <= 1 - t) return { prediction: 'lose', confidence: 1 - pWin };
  return null;
}


function valueToRank(value, guildId) {
  let tier, display;
  if (value >= 28) {
    const tierIdx = Math.min(Math.round(value / 4), 9);
    tier = TIERS[tierIdx];
    display = tier;
  } else {
    const tierIdx = Math.floor(value / 4);
    const divIdx = Math.round(value % 4);
    tier = TIERS[tierIdx];
    display = `${tier} ${DIVISIONS[Math.min(divIdx, 3)]}`;
  }
  const emojiOn = guildId ? isEmojiEnabled(guildId) : true;
  const emoji = emojiOn ? config.getRankEmoji(tier) : '';
  return emoji ? `${emoji} ${display}` : display;
}

async function getRankValue(puuid, region) {
  const entries = await getRankedStatsByPuuid(puuid, region);
  if (!entries || entries.rateLimited || !Array.isArray(entries)) {
    logger.debug({ puuid, region, entries: entries ?? 'null' }, 'getRankValue: ranked stats lookup failed');
    return null;
  }
  const solo = entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
  if (!solo) {
    logger.debug({ puuid, region, queueTypes: entries.map(e => e.queueType) }, 'getRankValue: no RANKED_SOLO_5x5 entry');
    return null;
  }
  logger.debug({ puuid, tier: solo.tier, rank: solo.rank }, 'getRankValue: success');
  return { value: rankToValue(solo.tier, solo.rank), tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAverageRank(participants, region, guildId) {
  // Query all participants — we have headroom on the personal-tier rate limits.
  const values = [];
  for (const p of participants) {
    const r = await getRankValue(p.puuid, region);
    if (r !== null) {
      values.push(r.value);
      p.tier = r.tier;   // used for the icon outline color + LP tag
      p.rank = r.rank;   // division (e.g. "II"); null for master+
      p.lp = r.lp;       // league points
    }
    await sleep(150); // ~6 req/sec, well under personal limits
  }
  if (values.length === 0) return 'Unranked';
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return valueToRank(avg, guildId);
}

async function checkForNewMatches() {
  const players = getAllTrackedPlayers();

  for (const player of players) {
    logger.debug({ riotTag: player.riot_tag, puuid: player.puuid, region: player.region }, 'Checking spectator for player');
    const game = await getActiveGame(player.puuid, player.region);

    if (game?.notFound) {
      peakLog.info('spectator: not in game', { riotTag: player.riot_tag });
      continue;
    }
    if (game?.rateLimited) {
      logger.warn({ riotTag: player.riot_tag }, 'Rate limited during new-match check, pausing tick');
      peakLog.warn('spectator: rate limited, pausing tick', { riotTag: player.riot_tag, retryAfter: game.retryAfter });
      return;
    }
    if (game?.httpError) {
      peakLog.warn('spectator: HTTP error (likely transient Riot/Cloudflare)', { riotTag: player.riot_tag, status: game.httpError });
      continue;
    }
    if (game?.networkError) {
      peakLog.warn('spectator: network error', { riotTag: player.riot_tag, err: game.networkError });
      continue;
    }
    if (game?.forbidden) {
      peakLog.warn('spectator: 403 forbidden', { riotTag: player.riot_tag });
      continue;
    }
    if (!game || !game.gameId) {
      peakLog.warn('spectator: unexpected response shape (no gameId)', { riotTag: player.riot_tag, response: game });
      continue;
    }
    peakLog.info('spectator: in game', { riotTag: player.riot_tag, gameId: game.gameId });

    const matchId = `${player.region.toUpperCase()}_${game.gameId}`;

    // Hard-skip queues that should never post (Arena, Co-op vs AI). Other
    // unknown queues — including the new ranked-5s mode — still post Match
    // Detected so people see the game; they get silently cancelled at the
    // Match Over step instead (see TRACKED_QUEUES check in checkActiveMatches).
    if (SKIP_QUEUES.has(game.gameQueueConfigId)) {
      peakLog.info('spectator: skipped queue', { riotTag: player.riot_tag, queue: game.gameQueueConfigId });
      continue;
    }

    const result = upsertActiveMatch(player.guild_id, player.puuid, matchId);
    if (result.changes > 0) {
      const name = getDisplayName(player.riot_tag);
      logger.info({ guildId: player.guild_id, riotTag: player.riot_tag, matchId }, 'New active match detected');
      registerBettingWindow(matchId);

      // Duo handling — find any OTHER tracked players in this guild who are
      // also in this game, upsert their active_matches rows up front, and
      // collect all puuids to highlight in the single shared image. Their
      // outer loop iteration will then no-op (changes=0) and avoid sending a
      // duplicate Match Detected.
      const participantPuuids = new Set((game.participants || []).map(p => p.puuid));
      const duoPartners = players.filter(pl =>
        pl.guild_id === player.guild_id &&
        pl.puuid !== player.puuid &&
        participantPuuids.has(pl.puuid)
      );
      for (const partner of duoPartners) {
        upsertActiveMatch(partner.guild_id, partner.puuid, matchId);
      }
      const trackedPuuidsAll = [player.puuid, ...duoPartners.map(p => p.puuid)];

      // Clear the previous Match Over embed for this player and any duo
      // partners (duo members share one Match Over message; whichever entry
      // triggers first will delete it, and the second will no-op when the
      // message is already gone).
      for (const pl of [player, ...duoPartners]) {
        const prevMatchOverId = getLastMatchOverMessage(pl.guild_id, pl.puuid);
        if (prevMatchOverId) {
          await deleteGuildMessage(pl.guild_id, prevMatchOverId);
          clearLastMatchOverMessage(pl.guild_id, pl.puuid);
        }
      }

      const participants = game.participants || [];
      // Side effect: stamps each participant with tier/rank/lp (used for the
      // icon ring colors + LP bubbles). The returned avg string is unused now
      // that the header shows the game mode instead.
      await getAverageRank(participants, player.region, player.guild_id);

      // Identify tracked player's team
      const trackedP = participants.find(p => p.puuid === player.puuid);
      const trackedTeamId = trackedP?.teamId || 100;
      const trackedChamp = trackedP ? getChampionName(trackedP.championId) : null;
      const sideEmoji = trackedTeamId === 100 ? '🔵' : '🔴';
      const sideName = trackedTeamId === 100 ? 'Blue' : 'Red';
      const sideColor = trackedTeamId === 100 ? 0x5DADE2 : 0xE74C3C;

      const blueTeam = participants.filter(p => p.teamId === 100);
      const redTeam = participants.filter(p => p.teamId === 200);

      // Lane inference per team — uses Meraki play-rate data. Falls back to
      // API order when inference is unavailable (no play-rate data, missing
      // champions, etc.).
      const orderByLane = (team) => {
        // Pass full participant objects so inferLanes can hard-pin the
        // smite-carrier to JUNGLE (smite is matchmaker-restricted to jng).
        const lanes = inferLanes(team);
        if (!lanes) return team;
        const ordered = [];
        for (const pos of ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']) {
          const champId = lanes[pos];
          const p = team.find(x => x.championId === champId);
          if (p && !ordered.includes(p)) ordered.push(p);
        }
        // Append any stragglers (shouldn't happen but defensive)
        for (const p of team) if (!ordered.includes(p)) ordered.push(p);
        return ordered;
      };

      const blueOrdered = orderByLane(blueTeam);
      const redOrdered = orderByLane(redTeam);

      // Roll for parlay (multi-leg prop bet — 2 to 4 legs, ALL must hit to
      // win). Pool is filtered to the tracked player's inferred role so we
      // don't suggest e.g. high-CS bets for supports.
      const existingParlay = getMatchParlay(player.guild_id, matchId);
      let parlayLegs = null;
      if (existingParlay) {
        parlayLegs = existingParlay;
      } else if (Math.random() < config.parleyChance) {
        const trackedTeam = trackedTeamId === 100 ? blueTeam : redTeam;
        const trackedLanes = inferLanes(trackedTeam);
        let trackedRole = 'MIDDLE'; // safe default if inference fails
        if (trackedLanes) {
          for (const pos of ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']) {
            if (trackedLanes[pos] === trackedP?.championId) { trackedRole = pos; break; }
          }
        }
        const legCount = 2 + Math.floor(Math.random() * 3);
        parlayLegs = pickParlayLegsForRole(trackedRole, legCount);
        setMatchParlay(player.guild_id, matchId, parlayLegs);
        logger.info({ matchId, role: trackedRole, legs: parlayLegs.length }, 'Parlay generated for match');
      }

      // Label resolver — tracked player uses their known tag; others use the
      // Spectator riotId game name when present (empty under streamer mode),
      // falling back to the champion name.
      const labelFor = (p) => {
        if (p.puuid === player.puuid) return getDisplayName(player.riot_tag);
        const gameName = (p.riotId || '').split('#')[0].trim();
        return gameName || getChampionName(p.championId);
      };

      // Process auto-bets up front so they can be baked into the image. Each
      // resolves to a plain line (no mentions) for the AUTO-BETS footer.
      const autoBetEntries = getAutoBetsForMatch(player.guild_id, player.puuid);
      const guild = client?.guilds.cache.get(player.guild_id);
      const autoBetLines = [];
      for (const ab of autoBetEntries) {
        if (getUserBetOnMatch(player.guild_id, ab.discord_id, matchId)) continue;

        let displayName = 'User';
        try {
          const member = guild?.members.cache.get(ab.discord_id) || await guild?.members.fetch(ab.discord_id);
          displayName = member?.displayName || member?.user.username || 'User';
        } catch { /* member left guild — fall back */ }

        const user = ensureUser(player.guild_id, ab.discord_id);
        if (user.coins < ab.amount) {
          autoBetLines.push(`• ${displayName} — skipped (low coins)`);
          continue;
        }
        deductCoins(player.guild_id, ab.discord_id, ab.amount);
        placeBet(player.guild_id, ab.discord_id, matchId, player.puuid, ab.prediction, ab.amount);
        const mult = ab.prediction === 'win' ? config.payoutMultiplier : config.losePayoutMultiplier;
        const potential = Math.floor(ab.amount * mult);
        autoBetLines.push(`• ${displayName} — bet ${ab.prediction.toUpperCase()} ${ab.amount.toLocaleString()} 🪙 → win ${potential.toLocaleString()} 🪙`);
      }

      // The House — automated rank-skill bettor.
      const houseChoice = computeHouseBet(participants, trackedTeamId);
      if (houseChoice && !getUserBetOnMatch(player.guild_id, HOUSE_ID, matchId)) {
        ensureUser(player.guild_id, HOUSE_ID);
        const houseUser = getUser(player.guild_id, HOUSE_ID);
        if (houseUser.coins < HOUSE_BET) {
          addCoins(player.guild_id, HOUSE_ID, HOUSE_TOPUP_TO - houseUser.coins);
        }
        deductCoins(player.guild_id, HOUSE_ID, HOUSE_BET);
        placeBet(player.guild_id, HOUSE_ID, matchId, player.puuid, houseChoice.prediction, HOUSE_BET, houseChoice.confidence);
        const hMult = houseChoice.prediction === 'win' ? config.payoutMultiplier : config.losePayoutMultiplier;
        const hPotential = Math.floor(HOUSE_BET * hMult);
        const conf = Math.round(houseChoice.confidence * 100);
        autoBetLines.push(`• ${HOUSE_LABEL} (${conf}%) — bet ${houseChoice.prediction.toUpperCase()} ${HOUSE_BET.toLocaleString()} 🪙 → win ${hPotential.toLocaleString()} 🪙`);
      }

      // Parlay summary for the image (label + legs line).
      let parlayInfo = null;
      if (parlayLegs) {
        const multiplier = Math.pow(config.parleyPayoutMultiplier, parlayLegs.length);
        const legSummary = parlayLegs.map(leg => {
          if (leg.type === 'yesno') return `${leg.label} Y/N`;
          return `${leg.label} O/U ${leg.line}`;
        }).join(' · ');
        parlayInfo = {
          label: `🎰 PARLAY · ${parlayLegs.length} LEGS · ${multiplier}× PAYOUT`,
          legs: legSummary,
        };
      }

      // Bans from Spectator-V5 — sorted by pickTurn so they render left→right
      // in the order they were banned.
      const banned = (game.bannedChampions || [])
        .slice()
        .sort((a, b) => a.pickTurn - b.pickTurn);
      const blueBans = banned.filter(b => b.teamId === 100).map(b => b.championId);
      const redBans = banned.filter(b => b.teamId === 200).map(b => b.championId);

      // Build the team composite PNG (header + per-team labels + parlay card).
      // Auto-bets and bet-status banner intentionally omitted from the image —
      // The House / autobet logic still runs upstream; we just don't surface
      // it in the render. Same for the open-betting countdown.
      const renderOpts = {
        blueTeam: blueOrdered,
        redTeam: redOrdered,
        trackedPuuid: player.puuid,
        trackedPuuids: trackedPuuidsAll,
        getChampionInternalId,
        getChampionName,
        getLabel: labelFor,
        title: 'MATCH DETECTED',
        subtitle: `${name}${trackedChamp ? ` on ${trackedChamp}` : ''}`,
        side: sideName,
        sideColor: trackedTeamId === 100 ? '#5DADE2' : '#e74c3c',
        gameMode: queueName(game),
        parlay: parlayInfo,
        blueBans,
        redBans,
        teamLabels: true,
      };
      const teamsPng = await renderTeamsCompositePng(renderOpts);

      // u.gg multisearch link — opens all 10 players side-by-side. Uses the
      // tracked player's known riot_tag and each other participant's riotId
      // (Spectator-V5 hides riotId in streamer mode → those players skipped).
      const multiTags = participants
        .map(p => p.puuid === player.puuid ? player.riot_tag : (p.riotId || ''))
        .filter(t => t && t.includes('#'))
        .map(t => encodeURIComponent(t));
      const uggUrl = multiTags.length > 0
        ? `https://u.gg/lol/multisearch?region=${player.region.toLowerCase()}&summoners=${multiTags.join(',')}`
        : null;

      const rowComponents = [
        new ButtonBuilder()
          .setCustomId(`bet_win_${matchId}`)
          .setLabel('🟢 WIN')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`bet_lose_${matchId}`)
          .setLabel('🔴 LOSE')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`autobet_${matchId}`)
          .setLabel('🟡 Auto-bet')
          .setStyle(ButtonStyle.Secondary),
      ];
      if (uggUrl) {
        rowComponents.push(
          new ButtonBuilder()
            .setLabel('🔗 u.gg')
            .setStyle(ButtonStyle.Link)
            .setURL(uggUrl),
        );
      }
      const row = new ActionRowBuilder().addComponents(...rowComponents);

      const components = [row];
      if (parlayLegs) {
        const parlayRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`parlay_place_${matchId}`)
            .setLabel('🎰 Place Parlay')
            .setStyle(ButtonStyle.Primary),
        );
        components.push(parlayRow);
      }

      const sendPayload = { components };
      if (uggUrl) uggUrlByMatch.set(matchId, uggUrl);
      if (teamsPng) {
        sendPayload.files = [{ attachment: teamsPng, name: 'teams.png' }];
      } else {
        // Render failed — fall back to a text-only Match Detected.
        sendPayload.content = `⚔ **MATCH DETECTED** — ${name}${trackedChamp ? ` on ${trackedChamp}` : ''}`;
      }
      const msg = await sendToGuild(player.guild_id, sendPayload);
      if (msg) {
        // Share this message_id across every tracked player in the match so
        // duo partners point at the same Discord message.
        setMatchMessageIdForAllInMatch(player.guild_id, matchId, msg.id);
        fileLog.info('Match embed sent, message ID saved', { matchId, guildId: player.guild_id, messageId: msg.id, players: trackedPuuidsAll.length });
      } else {
        fileLog.warn('Match embed send returned null — message ID not saved', { matchId, guildId: player.guild_id });
      }

      // Close betting after window expires
      setTimeout(() => {
        closeBetting(player.guild_id, player.puuid, matchId, name);
      }, config.bettingWindowMs);
    }
  }
}

async function closeBetting(guildId, puuid, matchId, playerName) {
  fileLog.info('closeBetting called', { guildId, matchId, playerName });

  const msgs = getMatchMessages(guildId, puuid, matchId);
  if (!msgs?.message_id) {
    fileLog.warn('closeBetting: no message_id found, cannot edit embed', { guildId, matchId, msgs: msgs ?? 'null' });
    return;
  }

  const guild = client?.guilds.cache.get(guildId);
  if (!guild) {
    fileLog.warn('closeBetting: guild not in cache', { guildId, matchId });
    return;
  }

  const configuredId = getGuildChannel(guildId);
  const channel = configuredId
    ? guild.channels.cache.get(configuredId)
    : guild.channels.cache.find(
        ch => ch.isTextBased() && !ch.isVoiceBased() && ch.permissionsFor(guild.members.me)?.has('SendMessages')
      );
  if (!channel) {
    fileLog.warn('closeBetting: channel not found', { guildId, matchId, configuredId: configuredId ?? 'none' });
    return;
  }

  try {
    const msg = await channel.messages.fetch(msgs.message_id);
    const cachedUgg = uggUrlByMatch.get(matchId);

    // Image has no open/closed banner anymore, so closing is just dropping
    // the betting buttons — keep u.gg if we had one. No delete, no re-render.
    const closedComponents = cachedUgg
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔗 u.gg').setStyle(ButtonStyle.Link).setURL(cachedUgg),
          ),
        ]
      : [];

    await msg.edit({ components: closedComponents });
    fileLog.info('closeBetting: edited buttons off', { matchId, messageId: msgs.message_id });
  } catch (err) {
    logger.warn({ err: err.message, matchId }, 'closeBetting: failed to refresh match message');
    fileLog.error('closeBetting: failed to refresh match message', { matchId, messageId: msgs.message_id, err: err.message, code: err.code });
  }
}

async function checkActiveMatches() {
  const matches = getAllActiveMatches();

  // Group rows by (guild_id, match_id) so duos in the same game are processed
  // together — one API call, one bet settlement, one Match Over embed.
  const groups = new Map();
  for (const match of matches) {
    const key = `${match.guild_id}:${match.match_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }

  for (const [, rows] of groups) {
    const first = rows[0];
    const result = await getMatchResult(first.match_id, getRegionForMatch(first));
    if (!result) {
      for (const row of rows) touchMatch(row.id);
      continue;
    }
    if (result.rateLimited) {
      logger.warn('Rate limited during active-match check, pausing tick');
      return;
    }
    if (result.forbidden) {
      logger.info({ matchId: first.match_id, guildId: first.guild_id }, 'Custom game detected (403 Forbidden), cancelling match');
      markMatchCancelled(first.guild_id, first.match_id);
      uggUrlByMatch.delete(first.match_id);

      // Refund all bets
      const refunded = cancelUnresolvedBets(first.guild_id, first.match_id);

      // Clean up messages (auto-bets are persistent — fire every game until cleared)
      for (const row of rows) {
        const msgs = getMatchMessages(row.guild_id, row.puuid, row.match_id);
        if (msgs) {
          await deleteGuildMessage(row.guild_id, msgs.message_id);
          await deleteGuildMessage(row.guild_id, msgs.close_message_id);
        }
        const extras = getActiveMatchExtraMessages(row.guild_id, row.puuid, row.match_id);
        for (const id of extras) await deleteGuildMessage(row.guild_id, id);
      }

      // Notify channel
      const refundLines = refunded.map(r => `<@${r.discordId}> — **${r.amount.toLocaleString()}** 🪙 refunded`);
      const desc = refundLines.length > 0
        ? `All bets have been refunded:\n${refundLines.join('\n')}`
        : '_No bets were placed on this match._';
      const embed = new EmbedBuilder()
        .setTitle('🚫 Custom Game — Match Cancelled')
        .setDescription(`Match **${first.match_id}** was a custom game and cannot be tracked.\n\n${desc}`)
        .setColor(0x95a5a6)
        .setTimestamp();
      sendToGuild(first.guild_id, { embeds: [embed] });
      continue;
    }

    // Silent cancel for queues that aren't in TRACKED_QUEUES — e.g. the new
    // ranked-5s mode. Match Detected already posted, but we skip Match Over
    // entirely: refund bets, delete the Match Detected message, no notice.
    const matchQueueId = result.info?.queueId;
    if (matchQueueId != null && !TRACKED_QUEUES.has(matchQueueId)) {
      logger.info({ matchId: first.match_id, guildId: first.guild_id, queueId: matchQueueId }, 'Untracked queue, silently cancelling match');
      markMatchCancelled(first.guild_id, first.match_id);
      uggUrlByMatch.delete(first.match_id);
      cancelUnresolvedBets(first.guild_id, first.match_id);
      for (const row of rows) {
        const msgs = getMatchMessages(row.guild_id, row.puuid, row.match_id);
        if (msgs) {
          await deleteGuildMessage(row.guild_id, msgs.message_id);
          await deleteGuildMessage(row.guild_id, msgs.close_message_id);
        }
        const extras = getActiveMatchExtraMessages(row.guild_id, row.puuid, row.match_id);
        for (const id of extras) await deleteGuildMessage(row.guild_id, id);
      }
      continue;
    }

    // Remake detection: Riot flags all participants with gameEndedInEarlySurrender
    // when /remake fires (AFK before 4 min). Fall back to a duration check in
    // case the field is missing on older matches.
    const firstParticipant = result.info?.participants?.[0];
    const isRemake = firstParticipant?.gameEndedInEarlySurrender === true
      || (typeof result.info?.gameDuration === 'number' && result.info.gameDuration < 300);

    if (isRemake) {
      logger.info({ matchId: first.match_id, guildId: first.guild_id, duration: result.info?.gameDuration }, 'Remake detected, cancelling match');
      markMatchCancelled(first.guild_id, first.match_id);
      uggUrlByMatch.delete(first.match_id);

      const refunded = cancelUnresolvedBets(first.guild_id, first.match_id);

      for (const row of rows) {
        const msgs = getMatchMessages(row.guild_id, row.puuid, row.match_id);
        if (msgs) {
          await deleteGuildMessage(row.guild_id, msgs.message_id);
          await deleteGuildMessage(row.guild_id, msgs.close_message_id);
        }
        const extras = getActiveMatchExtraMessages(row.guild_id, row.puuid, row.match_id);
        for (const id of extras) await deleteGuildMessage(row.guild_id, id);
      }

      const refundLines = refunded.map(r => `<@${r.discordId}> — **${r.amount.toLocaleString()}** 🪙 refunded`);
      const desc = refundLines.length > 0
        ? `Match was remade (AFK / early surrender before 4 min). All bets refunded — no W/L recorded.\n\n${refundLines.join('\n')}`
        : 'Match was remade (AFK / early surrender before 4 min). No W/L recorded.';
      const embed = new EmbedBuilder()
        .setTitle('🔄 Remake — Match Voided')
        .setDescription(desc)
        .setColor(0x95a5a6)
        .setTimestamp();
      sendToGuild(first.guild_id, { embeds: [embed], allowedMentions: { parse: [] } });
      continue;
    }

    logger.info({ matchId: first.match_id, guildId: first.guild_id, players: rows.length }, 'Match ended, settling bets');
    peakLog.info('match ended, entering per-player loop', { matchId: first.match_id, guildId: first.guild_id, players: rows.length });
    markMatchFinished(first.guild_id, first.match_id);
    uggUrlByMatch.delete(first.match_id);

    // Fetch the timeline once — reused for won-lane tracking, the wonLane
    // parlay leg, and the gold-lead chart. Failure degrades gracefully.
    let timeline = null;
    try {
      const tl = await getMatchTimeline(first.match_id, getRegionForMatch(first));
      if (tl && !tl.rateLimited && !tl.forbidden) timeline = tl;
    } catch (err) {
      logger.warn({ err: err.message, matchId: first.match_id }, 'Failed to fetch match timeline');
    }

    // ── Per-player cleanup (messages, auto-bets, daily stats, peak rank) ──
    const playerStatLines = [];
    const allPlayers = getAllTrackedPlayers();

    for (const row of rows) {
      // Delete this player's match detected + betting closed messages
      const msgs = getMatchMessages(row.guild_id, row.puuid, row.match_id);
      if (msgs) {
        fileLog.info('checkActiveMatches: deleting messages for finished match', {
          matchId: row.match_id, guildId: row.guild_id,
          messageId: msgs.message_id ?? 'null',
          closeMessageId: msgs.close_message_id ?? 'null',
        });
        await deleteGuildMessage(row.guild_id, msgs.message_id);
        await deleteGuildMessage(row.guild_id, msgs.close_message_id);
      } else {
        fileLog.warn('checkActiveMatches: no msgs row found for finished match — nothing to delete', { matchId: row.match_id, guildId: row.guild_id, puuid: row.puuid });
      }

      // Delete any auto-bet placed/skipped notifications tied to this match
      const extras = getActiveMatchExtraMessages(row.guild_id, row.puuid, row.match_id);
      for (const id of extras) await deleteGuildMessage(row.guild_id, id);

      const participant = result.info.participants.find(p => p.puuid === row.puuid);
      if (!participant) {
        logger.warn({ matchId: row.match_id, puuid: row.puuid }, 'Tracked player not found in match result');
        continue;
      }
      const won = participant.win;
      const trackedPlayer = allPlayers.find(p => p.puuid === row.puuid && p.guild_id === row.guild_id);
      const playerName = trackedPlayer ? getDisplayName(trackedPlayer.riot_tag) : 'Unknown';

      recordDailyResult(row.guild_id, row.puuid, won);

      // Always check peak rank (not just on wins) so climbs from untracked games are captured
      const riotTag = trackedPlayer?.riot_tag || 'unknown';
      const region = getRegionForMatch(row);
      peakLog.info('peak check: start', { riotTag, puuid: row.puuid, matchId: row.match_id, won, region });

      const rankEntries = await getRankedStatsByPuuid(row.puuid, region);

      if (!rankEntries) {
        peakLog.warn('peak check: getRankedStatsByPuuid returned null (network/HTTP error)', { riotTag });
      } else if (rankEntries.rateLimited) {
        peakLog.warn('peak check: rate limited', { riotTag, retryAfter: rankEntries.retryAfter });
      } else if (rankEntries.forbidden) {
        peakLog.warn('peak check: forbidden (403)', { riotTag });
      } else if (!Array.isArray(rankEntries)) {
        peakLog.warn('peak check: unexpected response shape', { riotTag, response: rankEntries });
      } else {
        peakLog.info('peak check: got entries', { riotTag, count: rankEntries.length, queueTypes: rankEntries.map(e => e.queueType) });
        const solo = rankEntries.find(e => e.queueType === 'RANKED_SOLO_5x5');
        if (!solo) {
          peakLog.warn('peak check: no RANKED_SOLO_5x5 entry', { riotTag });
        } else {
          const rv = rankToValue(solo.tier, solo.rank);
          peakLog.info('peak check: current rank', { riotTag, tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints, rankValue: rv });
          if (rv === null) {
            peakLog.warn('peak check: rankToValue returned null', { riotTag, tier: solo.tier, rank: solo.rank });
          } else {
            updatePeakRank(row.guild_id, row.puuid, solo.tier, solo.rank, solo.leaguePoints, rv);
            recordLp(row.guild_id, row.puuid, solo.tier, solo.rank, solo.leaguePoints, row.match_id);
          }
        }
      }

      // Won lane — compare gold@14 vs the enemy in the same teamPosition.
      // null = couldn't determine (no timeline, no role data, no role-opponent).
      const lane = timeline ? computeWonLane(timeline, result, row.puuid) : null;
      const wonLane = lane ? lane.won : null;
      const laneDiff = lane ? lane.diff : null;
      if (wonLane !== null) {
        recordLaneResult(row.guild_id, row.puuid, wonLane);
      }

      // Build stat line for this player
      const k = participant.kills, d = participant.deaths, a = participant.assists;
      const kda = d === 0 ? 'Perfect' : ((k + a) / d).toFixed(1);
      const cs = (participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0);
      const dmg = (participant.totalDamageDealtToChampions || 0).toLocaleString();
      const champName = getChampionName(participant.championId);
      // Kill participation: (k + a) / team total kills. Null on solo-kill-only
      // teams (div by zero) — the renderer shows "—" in that case.
      const teamKills = (result.info?.participants || [])
        .filter(pp => pp.teamId === participant.teamId)
        .reduce((sum, pp) => sum + (pp.kills || 0), 0);
      const kp = teamKills > 0 ? Math.round(((k + a) / teamKills) * 100) : null;
      playerStatLines.push({ playerName, won, champName, championId: participant.championId, k, d, a, kda, cs, dmg, kp, puuid: row.puuid, teamId: participant.teamId, wonLane, laneDiff });

    }

    if (playerStatLines.length === 0) continue;

    // Record duo results only for pairs who were on the same team in this match.
    // Two tracked players queued into the same lobby on opposite teams are not
    // a "duo" — they're opponents, and only one of them won.
    if (playerStatLines.length >= 2) {
      for (let i = 0; i < playerStatLines.length; i++) {
        for (let j = i + 1; j < playerStatLines.length; j++) {
          if (playerStatLines[i].teamId !== playerStatLines[j].teamId) continue;
          recordDuoResult(first.guild_id, playerStatLines[i].puuid, playerStatLines[j].puuid, playerStatLines[i].won);
        }
      }
    }

    // Use the first tracked player to determine win/loss for bet settlement
    // (duos are on the same team so outcome is identical)
    const primaryPlayer = playerStatLines[0];
    const trackedPlayerWon = primaryPlayer.won;

    // ── /predict10 progress + settlement ──────────────────────────────────
    // For each tracked player in this match, bump every open prediction by
    // one game (and one win if applicable). Settle when games_played hits 10.
    const predict10Lines = [];
    for (const psl of playerStatLines) {
      const opens = getOpenPredict10ForPlayer(first.guild_id, psl.puuid);
      for (const pred of opens) {
        const newGames = pred.games_played + 1;
        const newWins = pred.wins_so_far + (psl.won ? 1 : 0);
        if (newGames < 10) {
          updatePredict10Progress(pred.id, newGames, newWins);
          continue;
        }
        const diff = Math.abs(pred.predicted_wins - newWins);
        const mult = diff === 0 ? 5 : diff === 1 ? 2 : diff === 2 ? 1 : diff === 3 ? 0.5 : 0;
        const payout = Math.floor(pred.amount * mult);
        updatePredict10Progress(pred.id, newGames, newWins);
        settlePredict10(pred.id, payout);
        if (payout > 0) addCoins(first.guild_id, pred.discord_id, payout);
        const name = await resolveDiscordName(first.guild_id, pred.discord_id);
        const emoji = diff <= 1 ? '✅' : '❌';
        const result = payout > 0
          ? `won ${payout.toLocaleString()} 🪙 (${mult}×)`
          : 'lost it all';
        predict10Lines.push(`${emoji} ${name} · 🎯 ${psl.playerName} 10-game (predicted ${pred.predicted_wins}, got ${newWins}) → ${result}`);
      }
    }

    // ── Settle bets (once per match) ──────────────────────────────────────
    const bets = getUnresolvedBetsByMatch(first.guild_id, first.match_id);
    const betImgLines = [...predict10Lines];
    // Tag each user bet with its amount + isHouse flag so we can cap the
    // image bets-settled card at "House + top 2 by amount" further down.
    const userBetEntries = [];

    for (const bet of bets) {
      const predictedWin = bet.prediction === 'win';
      const correct = predictedWin === trackedPlayerWon;
      const outcome = correct ? 'correct' : 'incorrect';
      const multiplier = bet.prediction === 'win' ? config.payoutMultiplier : config.losePayoutMultiplier;
      const payout = correct ? bet.amount * multiplier : 0;

      resolveBet(bet.id, outcome);
      updateUserStats(first.guild_id, bet.discord_id, correct, payout);

      const emoji = correct ? '✅' : '❌';
      let streakText = '';
      if (correct) {
        const updated = getUser(first.guild_id, bet.discord_id);
        if (updated && updated.current_streak >= 3) streakText = ` (${updated.current_streak}🔥)`;
      }
      const betName = await resolveDiscordName(first.guild_id, bet.discord_id);
      const confSuffix = bet.discord_id === HOUSE_ID && bet.house_confidence != null
        ? ` (${Math.round(bet.house_confidence * 100)}%)`
        : '';
      const resultImg = correct ? `won ${payout.toLocaleString()} 🪙` : 'lost their bet';
      const line = `${emoji} ${betName}${confSuffix} · ${bet.prediction.toUpperCase()} ${bet.amount.toLocaleString()} 🪙 → ${resultImg}${streakText}`;
      betImgLines.push(line);
      userBetEntries.push({ amount: bet.amount, isHouse: bet.discord_id === HOUSE_ID, line });
    }

    // Image-only filter: cap the "BETS SETTLED" card at 3 lines — The House
    // (always shown) + the 2 largest user bets. Text fallback keeps all bets.
    const imgBetLines = [...predict10Lines];
    const house = userBetEntries.find(e => e.isHouse);
    const topUsers = userBetEntries
      .filter(e => !e.isHouse)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 2);
    if (house) imgBetLines.push(house.line);
    for (const u of topUsers) imgBetLines.push(u.line);

    const bettorIds = new Set(bets.map(b => b.discord_id));

    // ── Parlay settlement ──────────────────────────────────────────────────
    // Parlay uses the first tracked player's stats. ALL legs must hit to win.
    const parlayLegsData = getMatchParlay(first.guild_id, first.match_id);
    const parlayImgLines = [];
    if (parlayLegsData && parlayLegsData.length > 0) {
      const participant = result.info.participants.find(p => p.puuid === primaryPlayer.puuid);

      // Pre-compute team kill total once for KP math.
      const teamKills = (result.info?.participants || [])
        .filter(pp => pp.teamId === participant.teamId)
        .reduce((sum, pp) => sum + (pp.kills || 0), 0);

      // Calculate the actual stat value for each leg
      const legResults = parlayLegsData.map(leg => {
        const stat = leg.stat;
        let actualValue;
        switch (stat) {
          case 'won':
            actualValue = participant.win ? 1 : 0; break;
          case 'wonLane':
            actualValue = primaryPlayer.wonLane === true ? 1 : 0; break;
          case 'firstBlood':
            actualValue = participant.firstBloodKill ? 1 : 0; break;
          case 'tripleKill':
            actualValue = (participant.tripleKills || 0) > 0 ? 1 : 0; break;
          case 'multiKill':
            actualValue = ((participant.quadraKills || 0) + (participant.pentaKills || 0)) > 0 ? 1 : 0; break;
          case 'gameLength':
            actualValue = Math.round(result.info.gameDuration / 60 * 10) / 10; break;
          case 'kda':
            actualValue = Math.round(((participant.kills + participant.assists) / Math.max(participant.deaths, 1)) * 100) / 100; break;
          case 'kills':
            actualValue = participant.kills || 0; break;
          case 'deaths':
            actualValue = participant.deaths || 0; break;
          case 'assists':
            actualValue = participant.assists || 0; break;
          case 'cs':
            actualValue = (participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0); break;
          case 'visionScore':
            actualValue = participant.visionScore || 0; break;
          case 'wardsPlaced':
            actualValue = participant.wardsPlaced || 0; break;
          case 'wardsKilled':
            actualValue = participant.wardsKilled || 0; break;
          case 'killParticipation':
            actualValue = teamKills > 0
              ? Math.round(((participant.kills + participant.assists) / teamKills) * 100)
              : 0;
            break;
          case 'goldEarned':
            actualValue = Math.round(((participant.goldEarned || 0) / 1000) * 10) / 10; break;
          case 'damageDealt':
            actualValue = Math.round(((participant.totalDamageDealtToChampions || 0) / 1000) * 10) / 10; break;
          case 'damageTaken':
            actualValue = Math.round(((participant.totalDamageTaken || 0) / 1000) * 10) / 10; break;
          default:
            actualValue = participant[stat];
        }
        const overWins = actualValue > leg.line;
        return { leg, actualValue, overWins };
      });

      const multiplier = Math.pow(config.parleyPayoutMultiplier, parlayLegsData.length);
      const parleyBets = getUnresolvedParleyBetsByMatch(first.guild_id, first.match_id);
      for (const pb of parleyBets) bettorIds.add(pb.discord_id);

      // Only surface parlay detail in the image if someone actually took it.
      if (parleyBets.length > 0) {
        const legsCompact = legResults.map(r => {
          const isYesNo = YES_NO_STATS.has(r.leg.stat);
          if (isYesNo) return `${r.leg.label} ${r.actualValue > 0.5 ? '✓' : '✗'}`;
          return `${r.leg.label} ${r.overWins ? 'OVER' : 'UNDER'}`;
        }).join(' · ');
        parlayImgLines.push(`🎲 ${parlayLegsData.length}-leg: ${legsCompact}`);
      }

      for (const pb of parleyBets) {
        const predictions = JSON.parse(pb.predictions);
        // ALL legs must match — any wrong leg means a loss
        const allCorrect = legResults.every((r, i) => {
          const pred = predictions[i];
          if (pred === undefined) return false;
          const isYesNo = YES_NO_STATS.has(r.leg.stat);
          if (isYesNo) {
            const happened = r.actualValue > 0.5;
            return (pred === 'over') === happened;
          }
          return (pred === 'over') === r.overWins;
        });

        const payout = allCorrect ? Math.floor(pb.amount * multiplier) : 0;
        const outcome = allCorrect ? 'correct' : 'incorrect';

        resolveParleyBet(pb.id, outcome);
        updateUserStats(first.guild_id, pb.discord_id, allCorrect, payout);

        const pbEmoji = allCorrect ? '✅' : '❌';
        const pbName = await resolveDiscordName(first.guild_id, pb.discord_id);
        const resultText = allCorrect
          ? `won ${payout.toLocaleString()} 🪙 (${multiplier}x)`
          : `lost (${pb.amount.toLocaleString()} 🪙)`;
        parlayImgLines.push(`${pbEmoji} ${pbName} parlay → ${resultText}`);
      }
    }

    // Check achievements for all bettors
    const achImgLines = [];
    for (const discordId of bettorIds) {
      const newAch = checkAchievements(first.guild_id, discordId);
      if (newAch.length === 0) continue;
      const achName = await resolveDiscordName(first.guild_id, discordId);
      for (const ach of newAch) {
        achImgLines.push(`🏆 ${achName} unlocked ${ach.label}`);
      }
    }

    // ── Build Match Over recap image ───────────────────────────────────────
    const gameMins = Math.floor(result.info.gameDuration / 60);
    const gameSecs = result.info.gameDuration % 60;
    const durationStr = `${gameMins}:${String(gameSecs).padStart(2, '0')}`;

    if (bets.length > 0 || parlayImgLines.length > 0 || achImgLines.length > 0) {
      const imgPlayers = playerStatLines.map(p => {
        const daily = getDailyRecord(first.guild_id, p.puuid);
        return {
          name: p.playerName, championId: p.championId, champName: p.champName,
          k: p.k, d: p.d, a: p.a, kda: p.kda, cs: p.cs, dmg: p.dmg, kp: p.kp,
          dailyW: daily.wins, dailyL: daily.losses, wonLane: p.wonLane, laneDiff: p.laneDiff,
          // Per-player win flag — duos on opposite teams render correctly
          // when each card pulls its own W/L color.
          won: p.won,
        };
      });

      // Gold-lead chart data (rendered inside the composite). Degrades silently.
      let lead = null, objectives = [], kills = [];
      try {
        if (timeline) {
          const l = computeTeamGoldLead(timeline, result, primaryPlayer.puuid);
          if (l && l.length > 0) {
            lead = l;
            objectives = extractObjectiveEvents(timeline, result, primaryPlayer.puuid);
            kills = extractTrackedPlayerKills(timeline, primaryPlayer.puuid);
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, matchId: first.match_id }, 'Failed to build gold-lead data');
      }

      const matchOverPng = await renderMatchOverPng({
        won: trackedPlayerWon,
        durationStr,
        players: imgPlayers,
        getChampionInternalId,
        bets: imgBetLines,
        parlay: parlayImgLines,
        achievements: achImgLines,
        lead, objectives, kills,
      });

      // Full-lobby scoreboard panel — sent as a second attachment so Discord
      // lays it out next to the splash recap. Pulls every per-participant
      // stat straight from the Match-V5 response (no derived fields).
      const blueTeamMatch = (result.info?.participants || []).filter(p => p.teamId === 100);
      const redTeamMatch  = (result.info?.participants || []).filter(p => p.teamId === 200);
      const scoreboardPng = (blueTeamMatch.length && redTeamMatch.length)
        ? await renderMatchOverScoreboardPng({
            blueTeam: blueTeamMatch,
            redTeam: redTeamMatch,
            trackedPuuid: primaryPlayer.puuid,
            durationStr,
            getChampionInternalId,
            getChampionName,
          })
        : null;
      const impactPng = (blueTeamMatch.length && redTeamMatch.length)
        ? await renderMatchOverImpactPng({
            blueTeam: blueTeamMatch,
            redTeam: redTeamMatch,
            trackedPuuid: primaryPlayer.puuid,
            getChampionInternalId,
            getChampionName,
          })
        : null;

      let sendPayload;
      if (matchOverPng) {
        const files = [{ attachment: matchOverPng, name: 'match-over.png' }];
        if (scoreboardPng) files.push({ attachment: scoreboardPng, name: 'scoreboard.png' });
        if (impactPng) files.push({ attachment: impactPng, name: 'impact.png' });
        sendPayload = {
          files,
          // Keep in Chat button — gated by saveGraphAllowedUserIds in the handler.
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`keep_gold_${first.match_id}`).setLabel('📌 Keep in Chat').setStyle(ButtonStyle.Secondary),
            ),
          ],
          allowedMentions: { parse: [] },
        };
      } else {
        // Fallback to a minimal text embed if the image render failed.
        const titleNames = playerStatLines.map(p => p.playerName).join(' & ');
        sendPayload = {
          embeds: [new EmbedBuilder()
            .setTitle(`${trackedPlayerWon ? '🏆' : '💀'} Match Over — ${titleNames} ${trackedPlayerWon ? 'WON' : 'LOST'} (${durationStr})`)
            .setColor(trackedPlayerWon ? 0x2ecc71 : 0xe74c3c)
            .setDescription([...betImgLines, ...parlayImgLines, ...achImgLines].join('\n') || '_No bets were placed on this match._')
            .setTimestamp()],
        };
      }

      const matchOverMsg = await sendToGuild(first.guild_id, sendPayload);
      if (matchOverMsg) {
        for (const p of playerStatLines) {
          setLastMatchOverMessage(first.guild_id, p.puuid, matchOverMsg.id);
        }
      }
    }
  }
}

function getRegionForMatch(match) {
  const players = getAllTrackedPlayers();
  const player = players.find(p => p.puuid === match.puuid && p.guild_id === match.guild_id);
  return player?.region || config.riotRegion;
}

async function sendToGuild(guildId, messagePayload) {
  if (!client) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const configuredId = getGuildChannel(guildId);
  const channel = configuredId
    ? guild.channels.cache.get(configuredId)
    : guild.channels.cache.find(
        ch => ch.isTextBased() && !ch.isVoiceBased() && ch.permissionsFor(guild.members.me)?.has('SendMessages')
      );
  if (!channel) return null;
  try {
    return await channel.send(messagePayload);
  } catch (err) {
    logger.error({ err, guildId }, 'Failed to send notification');
    return null;
  }
}

async function deleteGuildMessage(guildId, messageId) {
  if (!client || !messageId) {
    logger.warn({ guildId, messageId: messageId ?? 'null' }, 'deleteGuildMessage: skipped (no client or messageId)');
    fileLog.warn('deleteGuildMessage: skipped — no client or messageId', { guildId, messageId: messageId ?? 'null' });
    return;
  }
  // Per-guild opt-out: preserve all bot messages for a dedicated bot channel.
  if (!isAutoDeleteEnabled(guildId)) {
    fileLog.info('deleteGuildMessage: skipped — auto_delete disabled', { guildId, messageId });
    return;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    logger.warn({ guildId }, 'deleteGuildMessage: guild not in cache');
    fileLog.warn('deleteGuildMessage: guild not in cache', { guildId, messageId });
    return;
  }
  const configuredId = getGuildChannel(guildId);
  const channel = configuredId
    ? guild.channels.cache.get(configuredId)
    : guild.channels.cache.find(
        ch => ch.isTextBased() && !ch.isVoiceBased() && ch.permissionsFor(guild.members.me)?.has('SendMessages')
      );
  if (!channel) {
    logger.warn({ guildId, configuredId }, 'deleteGuildMessage: channel not found');
    fileLog.warn('deleteGuildMessage: channel not found', { guildId, messageId, configuredId: configuredId ?? 'none' });
    return;
  }
  try {
    fileLog.info('deleteGuildMessage: attempting delete', { guildId, messageId, channelId: channel.id });
    const msg = await channel.messages.fetch(messageId);
    await msg.delete();
    logger.info({ messageId }, 'deleteGuildMessage: deleted successfully');
    fileLog.info('deleteGuildMessage: deleted successfully', { guildId, messageId, channelId: channel.id });
  } catch (err) {
    logger.warn({ err: err.message, messageId, channelId: channel.id }, 'Could not delete message');
    fileLog.error('deleteGuildMessage: failed', { guildId, messageId, channelId: channel.id, err: err.message, code: err.code });
  }
}
