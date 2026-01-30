import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import config from '../config.js';
import logger from './utils/logger.js';
import { getActiveGame, getMatchResult, getRankedStatsByPuuid } from './riot.js';
import { registerBettingWindow } from './utils/bettingwindow.js';
import {
  getAllTrackedPlayers,
  upsertActiveMatch,
  getAllActiveMatches,
  markMatchFinished,
  getUnresolvedBetsByMatch,
  resolveBet,
  updateUserStats,
  touchMatch,
  getGuildChannel,
  getActiveMatchByMatchId,
  setMatchParley,
  getMatchParley,
  getUnresolvedParleyBetsByMatch,
  resolveParleyBet,
  setMatchMessageId,
  setMatchCloseMessageId,
  getMatchMessages,
  recordDailyResult,
  getDailyRecord,
} from './db.js';

let client = null;
let pollTimer = null;

export function startPoller(discordClient) {
  client = discordClient;
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
  try {
    await checkForNewMatches();
    await checkActiveMatches();
  } catch (err) {
    logger.error({ err }, 'Poller tick error');
  }
}

function getDisplayName(riotTag) {
  return riotTag.split('#')[0];
}

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVISIONS = ['IV', 'III', 'II', 'I'];

function rankToValue(tier, division) {
  const tierIdx = TIERS.indexOf(tier);
  if (tierIdx < 0) return null;
  if (tierIdx >= 7) return tierIdx * 4; // MASTER+ have no divisions
  return tierIdx * 4 + DIVISIONS.indexOf(division);
}

function valueToRank(value) {
  if (value >= 28) {
    const tierIdx = Math.min(Math.round(value / 4), 9);
    return TIERS[tierIdx];
  }
  const tierIdx = Math.floor(value / 4);
  const divIdx = Math.round(value % 4);
  return `${TIERS[tierIdx]} ${DIVISIONS[Math.min(divIdx, 3)]}`;
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

async function getAverageRank(participants, region) {
  // Sample 5 of 10 players to halve API calls (10 calls instead of 20)
  const sampled = participants.length > 5
    ? participants.sort(() => 0.5 - Math.random()).slice(0, 5)
    : participants;

  const values = [];
  for (const p of sampled) {
    const v = await getRankValue(p.puuid, region);
    if (v !== null) values.push(v);
    await sleep(150); // ~6 req/sec to leave headroom for other calls
  }
  if (values.length === 0) return 'Unranked';
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return valueToRank(avg);
}

async function checkForNewMatches() {
  const players = getAllTrackedPlayers();

  for (const player of players) {
    logger.debug({ riotTag: player.riot_tag, puuid: player.puuid, region: player.region }, 'Checking spectator for player');
    const game = await getActiveGame(player.puuid, player.region);
    if (!game || game.rateLimited) {
      if (game?.rateLimited) {
        logger.warn({ riotTag: player.riot_tag }, 'Rate limited during new-match check, pausing tick');
        return;
      }
      logger.debug({ riotTag: player.riot_tag }, 'Player not in active game');
      continue;
    }

    const matchId = `${player.region.toUpperCase()}_${game.gameId}`;

    const result = upsertActiveMatch(player.guild_id, player.puuid, matchId);
    if (result.changes > 0) {
      const name = getDisplayName(player.riot_tag);
      logger.info({ guildId: player.guild_id, riotTag: player.riot_tag, matchId }, 'New active match detected');
      registerBettingWindow(matchId);

      const avgRank = await getAverageRank(game.participants || [], player.region);

      // Roll for parley (over/under stat bet)
      const hasParley = Math.random() < config.parleyChance;
      let parleyField = null;
      if (hasParley) {
        const stats = ['kills', 'deaths', 'kda'];
        const stat = stats[Math.floor(Math.random() * stats.length)];
        const ranges = { kills: [3.5, 8.5], deaths: [2.5, 6.5], kda: [1.5, 4.5] };
        const [min, max] = ranges[stat];
        const steps = Math.round((max - min) / (stat === 'kda' ? 0.5 : 1));
        const line = min + Math.floor(Math.random() * (steps + 1)) * (stat === 'kda' ? 0.5 : 1);
        setMatchParley(player.guild_id, matchId, stat, line);
        const label = stat === 'kda' ? 'KDA' : stat.charAt(0).toUpperCase() + stat.slice(1);
        parleyField = { stat, line, label };
        logger.info({ matchId, stat, line }, 'Parley generated for match');
      }

      const embed = new EmbedBuilder()
        .setTitle('🎮 Match Detected!')
        .setDescription(`**${name}** just entered a match!\n\n⏰ Betting closes in **3 minutes** — place your bets!`)
        .addFields({ name: '📊 Avg Rank', value: avgRank, inline: true })
        .setColor(0x2ecc71)
        .setTimestamp();

      if (parleyField) {
        embed.addFields({ name: '🎲 PARLEY', value: `Over/Under **${parleyField.line}** ${parleyField.label}`, inline: true });
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
      );

      const components = [row];
      if (parleyField) {
        const parleyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`parley_over_${matchId}`)
            .setLabel(`⬆️ OVER ${parleyField.line}`)
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`parley_under_${matchId}`)
            .setLabel(`⬇️ UNDER ${parleyField.line}`)
            .setStyle(ButtonStyle.Secondary),
        );
        components.push(parleyRow);
      }

      const msg = await sendToGuild(player.guild_id, { embeds: [embed], components });
      if (msg) setMatchMessageId(player.guild_id, matchId, msg.id);

      // Disable buttons after 3 minutes
      setTimeout(() => {
        closeBetting(player.guild_id, matchId, name);
      }, config.bettingWindowMs);
    }
  }
}

async function closeBetting(guildId, matchId, playerName) {
  const embed = new EmbedBuilder()
    .setTitle('🔒 Betting Closed')
    .setDescription(`Betting on **${playerName}**'s match is now closed. Good luck!`)
    .setColor(0x95a5a6)
    .setTimestamp();

  const msg = await sendToGuild(guildId, { embeds: [embed] });
  if (msg) setMatchCloseMessageId(guildId, matchId, msg.id);
}

async function checkActiveMatches() {
  const matches = getAllActiveMatches();

  for (const match of matches) {
    const result = await getMatchResult(match.match_id, getRegionForMatch(match));
    if (!result) {
      touchMatch(match.id);
      continue;
    }
    if (result.rateLimited) {
      logger.warn('Rate limited during active-match check, pausing tick');
      return;
    }

    logger.info({ matchId: match.match_id, guildId: match.guild_id }, 'Match ended, settling bets');
    markMatchFinished(match.guild_id, match.match_id);

    // Delete match detected and betting closed messages
    const msgs = getMatchMessages(match.guild_id, match.match_id);
    if (msgs) {
      await deleteGuildMessage(match.guild_id, msgs.message_id);
      await deleteGuildMessage(match.guild_id, msgs.close_message_id);
    }

    const participant = result.info.participants.find(p => p.puuid === match.puuid);
    if (!participant) {
      logger.warn({ matchId: match.match_id, puuid: match.puuid }, 'Tracked player not found in match result');
      continue;
    }
    const trackedPlayerWon = participant.win;

    // Find the player name and record daily result
    const players = getAllTrackedPlayers();
    const trackedPlayer = players.find(p => p.puuid === match.puuid && p.guild_id === match.guild_id);
    const playerName = trackedPlayer ? getDisplayName(trackedPlayer.riot_tag) : 'Unknown';

    recordDailyResult(match.guild_id, match.puuid, trackedPlayerWon);
    const daily = getDailyRecord(match.guild_id, match.puuid);

    const bets = getUnresolvedBetsByMatch(match.guild_id, match.match_id);
    const lines = [];

    for (const bet of bets) {
      const predictedWin = bet.prediction === 'win';
      const correct = predictedWin === trackedPlayerWon;
      const outcome = correct ? 'correct' : 'incorrect';
      const payout = correct ? bet.amount * config.payoutMultiplier : 0;

      resolveBet(bet.id, outcome);
      updateUserStats(match.guild_id, bet.discord_id, correct, payout);

      const emoji = correct ? '✅' : '❌';
      const resultText = correct ? `won **${payout.toLocaleString()}** 🪙` : 'lost their bet';
      lines.push(`${emoji} <@${bet.discord_id}> bet **${bet.prediction.toUpperCase()}** (${bet.amount.toLocaleString()} 🪙) — ${resultText}`);
    }

    // ── Parley settlement ──────────────────────────────────────────────────
    const parley = getMatchParley(match.guild_id, match.match_id);
    const parleyLines = [];
    if (parley?.parley_stat) {
      let actualValue;
      if (parley.parley_stat === 'kda') {
        actualValue = (participant.kills + participant.assists) / Math.max(participant.deaths, 1);
        actualValue = Math.round(actualValue * 100) / 100;
      } else {
        actualValue = participant[parley.parley_stat];
      }

      const overWins = actualValue > parley.parley_line;
      const statLabel = parley.parley_stat === 'kda' ? 'KDA' : parley.parley_stat.charAt(0).toUpperCase() + parley.parley_stat.slice(1);
      const winSide = overWins ? 'OVER' : 'UNDER';
      parleyLines.push(`🎲 **Parley:** ${actualValue} ${statLabel} (Line: ${parley.parley_line}) — **${winSide}** wins!`);

      const parleyBets = getUnresolvedParleyBetsByMatch(match.guild_id, match.match_id);
      for (const pb of parleyBets) {
        const correct = (pb.prediction === 'over') === overWins;
        const outcome = correct ? 'correct' : 'incorrect';
        const payout = correct ? pb.amount * config.parleyPayoutMultiplier : 0;

        resolveParleyBet(pb.id, outcome);
        updateUserStats(match.guild_id, pb.discord_id, correct, payout);

        const emoji = correct ? '✅' : '❌';
        const resultText = correct ? `won **${payout.toLocaleString()}** 🪙` : 'lost their bet';
        parleyLines.push(`${emoji} <@${pb.discord_id}> bet **${pb.prediction.toUpperCase()}** (${pb.amount.toLocaleString()} 🪙) — ${resultText}`);
      }
    }

    const outcomeEmoji = trackedPlayerWon ? '🏆' : '💀';
    const outcomeText = trackedPlayerWon ? 'WON' : 'LOST';

    let description = `**${playerName}** has **${outcomeText}** the match! (Today: ${daily.wins}W / ${daily.losses}L)\n\n` +
      (lines.length > 0 ? lines.join('\n') : '_No bets were placed on this match._');
    if (parleyLines.length > 0) {
      description += '\n\n' + parleyLines.join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle(`${outcomeEmoji} Match Over!`)
      .setDescription(description)
      .setColor(trackedPlayerWon ? 0x2ecc71 : 0xe74c3c)
      .setTimestamp();

    sendToGuild(match.guild_id, { embeds: [embed] });
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
  if (!client || !messageId) return;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const configuredId = getGuildChannel(guildId);
  const channel = configuredId
    ? guild.channels.cache.get(configuredId)
    : guild.channels.cache.find(
        ch => ch.isTextBased() && !ch.isVoiceBased() && ch.permissionsFor(guild.members.me)?.has('SendMessages')
      );
  if (!channel) return;
  try {
    const msg = await channel.messages.fetch(messageId);
    await msg.delete();
  } catch (err) {
    logger.debug({ err: err.message, messageId }, 'Could not delete message');
  }
}
