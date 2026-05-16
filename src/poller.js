import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import config from '../config.js';
import logger from './utils/logger.js';
import { fileLog } from './utils/fileLog.js';
import { peakLog } from './utils/peakLog.js';
import { getActiveGame, getMatchResult, getMatchTimeline, getRankedStatsByPuuid, loadChampionMap, getChampionName } from './riot.js';
import { computeTeamGoldLead, renderGoldLeadPng, extractObjectiveEvents, computeWonLane, extractTrackedPlayerKills } from './matchGraph.js';
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
  setMatchParlay,
  getMatchParlay,
  getUnresolvedParleyBetsByMatch,
  resolveParleyBet,
  setMatchMessageId,
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
  appendActiveMatchExtraMessage,
  getActiveMatchExtraMessages,
  ensureUser,
  getUser,
  getUserBetOnMatch,
  deductCoins,
  placeBet,
  isEmojiEnabled,
  checkAchievements,
  recordDuoResult,
} from './db.js';

let client = null;
let pollTimer = null;
let tickInProgress = false;

export async function startPoller(discordClient) {
  client = discordClient;
  await loadChampionMap();
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

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVISIONS = ['IV', 'III', 'II', 'I'];

const PARLEY_POOL = [
  { stat: 'kills', label: 'Kills', type: 'ou', min: 3.5, max: 8.5, step: 1 },
  { stat: 'deaths', label: 'Deaths', type: 'ou', min: 2.5, max: 6.5, step: 1 },
  { stat: 'kda', label: 'KDA', type: 'ou', min: 1.5, max: 4.5, step: 0.5 },
  { stat: 'cs', label: 'CS', type: 'ou', min: 120.5, max: 220.5, step: 10 },
  { stat: 'visionScore', label: 'Vision Score', type: 'ou', min: 15.5, max: 40.5, step: 5 },
  { stat: 'gameLength', label: 'Game Length (min)', type: 'ou', min: 22.5, max: 35.5, step: 1 },
  { stat: 'firstBlood', label: 'First Blood', type: 'yesno' },
  { stat: 'tripleKill', label: 'Triple Kill', type: 'yesno' },
  { stat: 'wonLane', label: 'Won Lane', type: 'yesno' },
];

const YES_NO_STATS = new Set(PARLEY_POOL.filter(p => p.type === 'yesno').map(p => p.stat));
const PARLEY_LABELS = Object.fromEntries(PARLEY_POOL.map(p => [p.stat, p.label]));

function rankToValue(tier, division) {
  const tierIdx = TIERS.indexOf(tier);
  if (tierIdx < 0) return null;
  if (tierIdx >= 7) return tierIdx * 4; // MASTER+ have no divisions
  return tierIdx * 4 + DIVISIONS.indexOf(division);
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
  return rankToValue(solo.tier, solo.rank);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAverageRank(participants, region, guildId) {
  // Query all participants — we have headroom on the personal-tier rate limits.
  const values = [];
  for (const p of participants) {
    const v = await getRankValue(p.puuid, region);
    if (v !== null) values.push(v);
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

    const result = upsertActiveMatch(player.guild_id, player.puuid, matchId);
    if (result.changes > 0) {
      const name = getDisplayName(player.riot_tag);
      logger.info({ guildId: player.guild_id, riotTag: player.riot_tag, matchId }, 'New active match detected');
      registerBettingWindow(matchId);

      // Clear the previous Match Over embed for this player (duo members
      // share one Match Over message; whichever entry triggers first will
      // delete it, and the second will no-op when the message is already
      // gone).
      const prevMatchOverId = getLastMatchOverMessage(player.guild_id, player.puuid);
      if (prevMatchOverId) {
        await deleteGuildMessage(player.guild_id, prevMatchOverId);
        clearLastMatchOverMessage(player.guild_id, player.puuid);
      }

      const participants = game.participants || [];
      const avgRank = await getAverageRank(participants, player.region, player.guild_id);

      // Identify tracked player's team and build team displays
      const trackedP = participants.find(p => p.puuid === player.puuid);
      const trackedTeamId = trackedP?.teamId || 100;
      const trackedChamp = trackedP ? getChampionName(trackedP.championId) : null;
      const sideLabel = trackedTeamId === 100 ? '🔵 Blue Side' : '🔴 Red Side';
      const allies = participants.filter(p => p.teamId === trackedTeamId);
      const enemies = participants.filter(p => p.teamId !== trackedTeamId);
      const formatTeam = (team) => team.map(p => {
        const champ = getChampionName(p.championId);
        return p.puuid === player.puuid ? `**${champ}** (${name})` : champ;
      }).join(', ');

      // Roll for parlay (multi-leg prop bet — 2 to 4 legs, ALL must hit to win)
      // If another tracked player in the same game already generated a parlay, reuse it
      const existingParlay = getMatchParlay(player.guild_id, matchId);
      let parlayLegs = null;
      if (existingParlay) {
        parlayLegs = existingParlay;
      } else if (Math.random() < config.parleyChance) {
        const legCount = 2 + Math.floor(Math.random() * 3); // 2, 3, or 4 legs
        const shuffled = [...PARLEY_POOL].sort(() => 0.5 - Math.random());
        const picks = shuffled.slice(0, legCount);
        parlayLegs = picks.map(pick => {
          let line;
          if (pick.type === 'yesno') {
            line = 0.5;
          } else {
            const steps = Math.round((pick.max - pick.min) / pick.step);
            line = pick.min + Math.floor(Math.random() * (steps + 1)) * pick.step;
          }
          return { stat: pick.stat, label: pick.label, type: pick.type, line };
        });
        setMatchParlay(player.guild_id, matchId, parlayLegs);
        logger.info({ matchId, legs: parlayLegs.length }, 'Parlay generated for match');
      }

      const titleChamp = trackedChamp ? ` — playing ${trackedChamp}` : '';
      const embed = new EmbedBuilder()
        .setTitle('🎮 Match Detected!')
        .setDescription(`**${name}**${titleChamp} (${sideLabel})\n\n⏰ Betting closes in **5 minutes** — place your bets!\n🟢 WIN pays **${config.payoutMultiplier}x** · 🔴 LOSE pays **${config.losePayoutMultiplier}x**`)
        .addFields(
          { name: '📊 Avg Rank', value: avgRank, inline: true },
          { name: `🔵 ${name}'s Team`, value: formatTeam(allies) || 'Unknown', inline: false },
          { name: '🔴 Enemy Team', value: formatTeam(enemies) || 'Unknown', inline: false },
        )
        .setColor(0x2ecc71)
        .setTimestamp();

      if (parlayLegs) {
        const multiplier = Math.pow(config.parleyPayoutMultiplier, parlayLegs.length);
        const legDesc = parlayLegs.map((leg, i) => {
          if (leg.type === 'yesno') return `**Leg ${i + 1}:** ${leg.label} — YES or NO`;
          return `**Leg ${i + 1}:** ${leg.label} — Over/Under **${leg.line}**`;
        }).join('\n');
        embed.addFields({ name: `🎲 PARLAY — ${parlayLegs.length} Legs (${multiplier}x if ALL hit!)`, value: legDesc, inline: false });
      }

      const row = new ActionRowBuilder().addComponents(
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
      );

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

      const msg = await sendToGuild(player.guild_id, { embeds: [embed], components });
      if (msg) {
        setMatchMessageId(player.guild_id, player.puuid, matchId, msg.id);
        fileLog.info('Match embed sent, message ID saved', { matchId, guildId: player.guild_id, messageId: msg.id });
      } else {
        fileLog.warn('Match embed send returned null — message ID not saved', { matchId, guildId: player.guild_id });
      }

      // Process auto-bets
      const autoBets = getAutoBetsForMatch(player.guild_id, player.puuid);
      const guild = client?.guilds.cache.get(player.guild_id);
      for (const ab of autoBets) {
        const existing = getUserBetOnMatch(player.guild_id, ab.discord_id, matchId);
        if (existing) continue;

        let displayName = 'User';
        try {
          const member = guild?.members.cache.get(ab.discord_id) || await guild?.members.fetch(ab.discord_id);
          displayName = member?.displayName || member?.user.username || 'User';
        } catch { /* member left guild — fall back */ }

        const user = ensureUser(player.guild_id, ab.discord_id);
        if (user.coins < ab.amount) {
          const skipMsg = await sendToGuild(player.guild_id, {
            content: `🤖 Auto-bet skipped for ${displayName} — insufficient coins (need **${ab.amount.toLocaleString()}** 🪙, have **${user.coins.toLocaleString()}** 🪙)`,
            allowedMentions: { parse: [] },
          });
          if (skipMsg) appendActiveMatchExtraMessage(player.guild_id, player.puuid, matchId, skipMsg.id);
          continue;
        }

        deductCoins(player.guild_id, ab.discord_id, ab.amount);
        placeBet(player.guild_id, ab.discord_id, matchId, player.puuid, ab.prediction, ab.amount);

        const emoji = ab.prediction === 'win' ? '🟢' : '🔴';
        const placedMsg = await sendToGuild(player.guild_id, {
          content: `🤖 Auto-bet: ${displayName} bet ${emoji} **${ab.prediction.toUpperCase()}** for **${ab.amount.toLocaleString()}** 🪙`,
          allowedMentions: { parse: [] },
        });
        if (placedMsg) appendActiveMatchExtraMessage(player.guild_id, player.puuid, matchId, placedMsg.id);
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
    const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
      .setTitle('🔒 BETTING CLOSED')
      .setColor(0x95a5a6);
    await msg.edit({ embeds: [updatedEmbed], components: [] });
    fileLog.info('closeBetting: embed updated to BETTING CLOSED', { matchId, messageId: msgs.message_id });
  } catch (err) {
    logger.warn({ err: err.message, matchId }, 'closeBetting: failed to edit match message');
    fileLog.error('closeBetting: failed to edit match message', { matchId, messageId: msgs.message_id, err: err.message, code: err.code });
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

    // Remake detection: Riot flags all participants with gameEndedInEarlySurrender
    // when /remake fires (AFK before 4 min). Fall back to a duration check in
    // case the field is missing on older matches.
    const firstParticipant = result.info?.participants?.[0];
    const isRemake = firstParticipant?.gameEndedInEarlySurrender === true
      || (typeof result.info?.gameDuration === 'number' && result.info.gameDuration < 300);

    if (isRemake) {
      logger.info({ matchId: first.match_id, guildId: first.guild_id, duration: result.info?.gameDuration }, 'Remake detected, cancelling match');
      markMatchCancelled(first.guild_id, first.match_id);

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
      const wonLane = timeline ? computeWonLane(timeline, result, row.puuid) : null;
      if (wonLane !== null) {
        recordLaneResult(row.guild_id, row.puuid, wonLane);
      }

      // Build stat line for this player
      const k = participant.kills, d = participant.deaths, a = participant.assists;
      const kda = d === 0 ? 'Perfect' : ((k + a) / d).toFixed(1);
      const cs = (participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0);
      const dmg = (participant.totalDamageDealtToChampions || 0).toLocaleString();
      const champName = getChampionName(participant.championId);
      playerStatLines.push({ playerName, won, champName, k, d, a, kda, cs, dmg, puuid: row.puuid, teamId: participant.teamId, wonLane });
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

    // ── Settle bets (once per match) ──────────────────────────────────────
    const bets = getUnresolvedBetsByMatch(first.guild_id, first.match_id);
    const lines = [];

    for (const bet of bets) {
      const predictedWin = bet.prediction === 'win';
      const correct = predictedWin === trackedPlayerWon;
      const outcome = correct ? 'correct' : 'incorrect';
      const multiplier = bet.prediction === 'win' ? config.payoutMultiplier : config.losePayoutMultiplier;
      const payout = correct ? bet.amount * multiplier : 0;

      resolveBet(bet.id, outcome);
      updateUserStats(first.guild_id, bet.discord_id, correct, payout);

      const emoji = correct ? '✅' : '❌';
      const resultText = correct ? `won **${payout.toLocaleString()}** 🪙` : 'lost their bet';
      let streakText = '';
      if (correct) {
        const updated = getUser(first.guild_id, bet.discord_id);
        if (updated && updated.current_streak >= 3) streakText = ` (${updated.current_streak} streak 🔥)`;
      }
      lines.push(`${emoji} <@${bet.discord_id}> bet **${bet.prediction.toUpperCase()}** (${bet.amount.toLocaleString()} 🪙) — ${resultText}${streakText}`);
    }

    const bettorIds = new Set(bets.map(b => b.discord_id));

    // ── Parlay settlement ──────────────────────────────────────────────────
    // Parlay uses the first tracked player's stats. ALL legs must hit to win.
    const parlayLegsData = getMatchParlay(first.guild_id, first.match_id);
    const parleyLines = [];
    if (parlayLegsData && parlayLegsData.length > 0) {
      const participant = result.info.participants.find(p => p.puuid === primaryPlayer.puuid);

      // Calculate the actual stat value for each leg
      const legResults = parlayLegsData.map(leg => {
        const stat = leg.stat;
        let actualValue;
        if (stat === 'kda') {
          actualValue = (participant.kills + participant.assists) / Math.max(participant.deaths, 1);
          actualValue = Math.round(actualValue * 100) / 100;
        } else if (stat === 'cs') {
          actualValue = (participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0);
        } else if (stat === 'visionScore') {
          actualValue = participant.visionScore || 0;
        } else if (stat === 'gameLength') {
          actualValue = Math.round(result.info.gameDuration / 60 * 10) / 10;
        } else if (stat === 'firstBlood') {
          actualValue = participant.firstBloodKill ? 1 : 0;
        } else if (stat === 'tripleKill') {
          actualValue = (participant.tripleKills || 0) > 0 ? 1 : 0;
        } else if (stat === 'wonLane') {
          // Falls back to 0 (did NOT win lane) if the timeline lookup failed.
          actualValue = primaryPlayer.wonLane === true ? 1 : 0;
        } else {
          actualValue = participant[stat];
        }
        const overWins = actualValue > leg.line;
        return { leg, actualValue, overWins };
      });

      // Build per-leg result summary
      const legSummary = legResults.map((r, i) => {
        const isYesNo = YES_NO_STATS.has(r.leg.stat);
        if (isYesNo) {
          const happened = r.actualValue > 0.5;
          return `Leg ${i + 1} **${r.leg.label}**: **${happened ? 'YES' : 'NO'}**`;
        }
        const side = r.overWins ? 'OVER' : 'UNDER';
        return `Leg ${i + 1} **${r.leg.label}**: ${r.actualValue} (line ${r.leg.line}) — **${side}**`;
      }).join('\n');
      parleyLines.push(`🎲 **Parlay Results:**\n${legSummary}`);

      const multiplier = Math.pow(config.parleyPayoutMultiplier, parlayLegsData.length);
      const parleyBets = getUnresolvedParleyBetsByMatch(first.guild_id, first.match_id);
      for (const pb of parleyBets) bettorIds.add(pb.discord_id);
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
        const resultText = allCorrect
          ? `won **${payout.toLocaleString()}** 🪙 (${multiplier}x)`
          : `lost their parlay (${pb.amount.toLocaleString()} 🪙)`;
        parleyLines.push(`${pbEmoji} <@${pb.discord_id}> — ${resultText}`);
      }
    }

    // Check achievements for all bettors
    const achLines = [];
    for (const discordId of bettorIds) {
      const newAch = checkAchievements(first.guild_id, discordId);
      for (const ach of newAch) {
        achLines.push(`🏆 <@${discordId}> unlocked **${ach.label}**`);
      }
    }

    // ── Build Match Over embed ─────────────────────────────────────────────
    const outcomeEmoji = trackedPlayerWon ? '🏆' : '💀';
    const outcomeText = trackedPlayerWon ? 'WON' : 'LOST';
    const gameMins = Math.floor(result.info.gameDuration / 60);
    const gameSecs = result.info.gameDuration % 60;
    const durationStr = `${gameMins}:${String(gameSecs).padStart(2, '0')}`;

    // Build stat lines for all tracked players in the match
    const statLines = playerStatLines.map(p => {
      const daily = getDailyRecord(first.guild_id, p.puuid);
      const total = daily.wins + daily.losses;
      const winRate = total > 0 ? daily.wins / total : 0;
      const flame = winRate > 0.5 ? ' 🔥' : '';
      const dailySuffix = ` (Today: ${daily.wins}W / ${daily.losses}L${flame})`;
      const laneTag = p.wonLane === true ? ' · 🛣️ **Won Lane**'
                     : p.wonLane === false ? ' · 🛣️ Lost Lane'
                     : '';
      return `**${p.playerName}**${dailySuffix}\n**${p.champName}** — ${p.k}/${p.d}/${p.a} (${p.kda} KDA) · ${p.cs} CS · ${p.dmg} DMG${laneTag}`;
    });

    const playerNames = playerStatLines.map(p => `**${p.playerName}**`).join(' & ');
    let description = `${playerNames} ${playerStatLines.length > 1 ? 'have' : 'has'} **${outcomeText}** the match! (${durationStr})\n\n` +
      statLines.join('\n\n') + '\n\n' +
      (lines.length > 0 ? lines.join('\n') : '_No bets were placed on this match._');
    if (parleyLines.length > 0) {
      description += '\n\n' + parleyLines.join('\n');
    }
    if (achLines.length > 0) {
      description += '\n\n' + achLines.join('\n');
    }

    if (bets.length > 0 || parleyLines.length > 0 || achLines.length > 0) {
      // Render gold-lead chart from the timeline fetched earlier. Failures
      // fall through silently — embed still posts without the chart.
      let chartFile = null;
      try {
        if (timeline) {
          const lead = computeTeamGoldLead(timeline, result, primaryPlayer.puuid);
          if (lead && lead.length > 0) {
            const objectives = extractObjectiveEvents(timeline, result, primaryPlayer.puuid);
            const kills = extractTrackedPlayerKills(timeline, primaryPlayer.puuid);
            const pngBuf = await renderGoldLeadPng(lead, { objectives, kills });
            if (pngBuf) chartFile = { attachment: pngBuf, name: 'gold-lead.png' };
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, matchId: first.match_id }, 'Failed to render gold-lead chart');
      }

      const embed = new EmbedBuilder()
        .setTitle(`${outcomeEmoji} Match Over!`)
        .setDescription(description)
        .setColor(trackedPlayerWon ? 0x2ecc71 : 0xe74c3c)
        .setTimestamp();
      if (chartFile) embed.setImage('attachment://gold-lead.png');

      const sendPayload = { embeds: [embed] };
      if (chartFile) {
        sendPayload.files = [chartFile];
        // Save (to disk) and Keep (re-post as standalone chat message)
        // — both gated by saveGraphAllowedUserIds in the handlers.
        sendPayload.components = [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`save_gold_${first.match_id}`)
              .setLabel('💾 Save')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(`keep_gold_${first.match_id}`)
              .setLabel('📌 Keep in Chat')
              .setStyle(ButtonStyle.Secondary)
          ),
        ];
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
