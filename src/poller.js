import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import config from '../config.js';
import logger from './utils/logger.js';
import { getActiveGame, getMatchResult, getRankedStatsByPuuid, loadChampionMap, getChampionName } from './riot.js';
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
  setMatchParley,
  getMatchParley,
  getUnresolvedParleyBetsByMatch,
  resolveParleyBet,
  setMatchMessageId,
  setMatchCloseMessageId,
  getMatchMessages,
  recordDailyResult,
  getDailyRecord,
  updatePeakRank,
  getAutoBetsForMatch,
  ensureUser,
  getUser,
  getUserBetOnMatch,
  deductCoins,
  placeBet,
  isEmojiEnabled,
} from './db.js';

let client = null;
let pollTimer = null;

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

const PARLEY_POOL = [
  { stat: 'kills', label: 'Kills', type: 'ou', min: 3.5, max: 8.5, step: 1 },
  { stat: 'deaths', label: 'Deaths', type: 'ou', min: 2.5, max: 6.5, step: 1 },
  { stat: 'kda', label: 'KDA', type: 'ou', min: 1.5, max: 4.5, step: 0.5 },
  { stat: 'cs', label: 'CS', type: 'ou', min: 120.5, max: 220.5, step: 10 },
  { stat: 'visionScore', label: 'Vision Score', type: 'ou', min: 15.5, max: 40.5, step: 5 },
  { stat: 'gameLength', label: 'Game Length (min)', type: 'ou', min: 22.5, max: 35.5, step: 1 },
  { stat: 'firstBlood', label: 'First Blood', type: 'yesno' },
  { stat: 'tripleKill', label: 'Triple Kill', type: 'yesno' },
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
  return valueToRank(avg, guildId);
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

      const participants = game.participants || [];
      const avgRank = await getAverageRank(participants, player.region, player.guild_id);

      // Identify tracked player's team and build team displays
      const trackedP = participants.find(p => p.puuid === player.puuid);
      const trackedTeamId = trackedP?.teamId || 100;
      const trackedChamp = trackedP ? getChampionName(trackedP.championId) : null;
      const sideLabel = trackedTeamId === 100 ? '🔵 Blue Side' : '🔴 Red Side';
      const allies = participants.filter(p => p.teamId === trackedTeamId);
      const enemies = participants.filter(p => p.teamId !== trackedTeamId);
      const formatTeam = (team) => team.map(p => getChampionName(p.championId)).join(', ');

      // Roll for parley (over/under or yes/no stat bet)
      const hasParley = Math.random() < config.parleyChance;
      let parleyField = null;
      if (hasParley) {
        const pick = PARLEY_POOL[Math.floor(Math.random() * PARLEY_POOL.length)];
        let line;
        if (pick.type === 'yesno') {
          line = 0.5;
        } else {
          const steps = Math.round((pick.max - pick.min) / pick.step);
          line = pick.min + Math.floor(Math.random() * (steps + 1)) * pick.step;
        }
        setMatchParley(player.guild_id, matchId, pick.stat, line);
        parleyField = { stat: pick.stat, line, label: pick.label, type: pick.type };
        logger.info({ matchId, stat: pick.stat, line, type: pick.type }, 'Parley generated for match');
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

      if (parleyField) {
        if (parleyField.type === 'yesno') {
          embed.addFields({ name: '🎲 PARLEY', value: `Will **${name}** get **${parleyField.label}**?`, inline: true });
        } else {
          embed.addFields({ name: '🎲 PARLEY', value: `Over/Under **${parleyField.line}** ${parleyField.label}`, inline: true });
        }
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
        let parleyRow;
        if (parleyField.type === 'yesno') {
          parleyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`parley_over_${matchId}`)
              .setLabel('✅ YES')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`parley_under_${matchId}`)
              .setLabel('❌ NO')
              .setStyle(ButtonStyle.Danger),
          );
        } else {
          parleyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`parley_over_${matchId}`)
              .setLabel(`⬆️ OVER ${parleyField.line}`)
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`parley_under_${matchId}`)
              .setLabel(`⬇️ UNDER ${parleyField.line}`)
              .setStyle(ButtonStyle.Secondary),
          );
        }
        components.push(parleyRow);
      }

      const msg = await sendToGuild(player.guild_id, { embeds: [embed], components });
      if (msg) setMatchMessageId(player.guild_id, matchId, msg.id);

      // Process auto-bets
      const autoBets = getAutoBetsForMatch(player.guild_id, player.puuid);
      for (const ab of autoBets) {
        const existing = getUserBetOnMatch(player.guild_id, ab.discord_id, matchId);
        if (existing) continue;

        const user = ensureUser(player.guild_id, ab.discord_id);
        if (user.coins < ab.amount) {
          sendToGuild(player.guild_id, {
            content: `🤖 Auto-bet skipped for <@${ab.discord_id}> — insufficient coins (need **${ab.amount.toLocaleString()}** 🪙, have **${user.coins.toLocaleString()}** 🪙)`,
          });
          continue;
        }

        deductCoins(player.guild_id, ab.discord_id, ab.amount);
        placeBet(player.guild_id, ab.discord_id, matchId, player.puuid, ab.prediction, ab.amount);

        const emoji = ab.prediction === 'win' ? '🟢' : '🔴';
        sendToGuild(player.guild_id, {
          content: `🤖 Auto-bet: <@${ab.discord_id}> bet ${emoji} **${ab.prediction.toUpperCase()}** for **${ab.amount.toLocaleString()}** 🪙`,
        });
      }

      // Close betting after window expires
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

    // Update peak rank after match
    if (trackedPlayerWon) {
      const rankEntries = await getRankedStatsByPuuid(match.puuid, getRegionForMatch(match));
      if (rankEntries && !rankEntries.rateLimited && Array.isArray(rankEntries)) {
        const solo = rankEntries.find(e => e.queueType === 'RANKED_SOLO_5x5');
        if (solo) {
          const rv = rankToValue(solo.tier, solo.rank);
          if (rv !== null) {
            updatePeakRank(match.guild_id, match.puuid, solo.tier, solo.rank, solo.leaguePoints, rv);
          }
        }
      }
    }

    const bets = getUnresolvedBetsByMatch(match.guild_id, match.match_id);
    const lines = [];

    for (const bet of bets) {
      const predictedWin = bet.prediction === 'win';
      const correct = predictedWin === trackedPlayerWon;
      const outcome = correct ? 'correct' : 'incorrect';
      const multiplier = bet.prediction === 'win' ? config.payoutMultiplier : config.losePayoutMultiplier;
      const payout = correct ? bet.amount * multiplier : 0;

      resolveBet(bet.id, outcome);
      updateUserStats(match.guild_id, bet.discord_id, correct, payout);

      const emoji = correct ? '✅' : '❌';
      const resultText = correct ? `won **${payout.toLocaleString()}** 🪙` : 'lost their bet';
      let streakText = '';
      if (correct) {
        const updated = getUser(match.guild_id, bet.discord_id);
        if (updated && updated.current_streak >= 3) streakText = ` (${updated.current_streak} streak 🔥)`;
      }
      lines.push(`${emoji} <@${bet.discord_id}> bet **${bet.prediction.toUpperCase()}** (${bet.amount.toLocaleString()} 🪙) — ${resultText}${streakText}`);
    }

    // ── Parley settlement ──────────────────────────────────────────────────
    const parley = getMatchParley(match.guild_id, match.match_id);
    const parleyLines = [];
    if (parley?.parley_stat) {
      const stat = parley.parley_stat;
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
      } else {
        actualValue = participant[stat]; // kills, deaths
      }

      const isYesNo = YES_NO_STATS.has(stat);
      const overWins = actualValue > parley.parley_line;
      const statLabel = PARLEY_LABELS[stat] || stat;

      if (isYesNo) {
        const happened = actualValue > 0.5;
        const winSide = happened ? 'YES' : 'NO';
        parleyLines.push(`🎲 **Parley:** ${statLabel} — **${winSide}!**`);
      } else {
        const winSide = overWins ? 'OVER' : 'UNDER';
        parleyLines.push(`🎲 **Parley:** ${actualValue} ${statLabel} (Line: ${parley.parley_line}) — **${winSide}** wins!`);
      }

      const parleyBets = getUnresolvedParleyBetsByMatch(match.guild_id, match.match_id);
      for (const pb of parleyBets) {
        const correct = (pb.prediction === 'over') === overWins;
        const outcome = correct ? 'correct' : 'incorrect';
        const payout = correct ? pb.amount * config.parleyPayoutMultiplier : 0;

        resolveParleyBet(pb.id, outcome);
        updateUserStats(match.guild_id, pb.discord_id, correct, payout);

        const pbEmoji = correct ? '✅' : '❌';
        const resultText = correct ? `won **${payout.toLocaleString()}** 🪙` : 'lost their bet';
        const displayPred = isYesNo
          ? (pb.prediction === 'over' ? 'YES' : 'NO')
          : pb.prediction.toUpperCase();
        parleyLines.push(`${pbEmoji} <@${pb.discord_id}> bet **${displayPred}** (${pb.amount.toLocaleString()} 🪙) — ${resultText}`);
      }
    }

    // Build tracked player's post-game stat line
    const k = participant.kills, d = participant.deaths, a = participant.assists;
    const kda = d === 0 ? 'Perfect' : ((k + a) / d).toFixed(1);
    const cs = (participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0);
    const dmg = (participant.totalDamageDealtToChampions || 0).toLocaleString();
    const champName = getChampionName(participant.championId);
    const statLine = `**${champName}** — ${k}/${d}/${a} (${kda} KDA) · ${cs} CS · ${dmg} DMG`;

    const outcomeEmoji = trackedPlayerWon ? '🏆' : '💀';
    const outcomeText = trackedPlayerWon ? 'WON' : 'LOST';

    const gameMins = Math.floor(result.info.gameDuration / 60);
    const gameSecs = result.info.gameDuration % 60;
    const durationStr = `${gameMins}:${String(gameSecs).padStart(2, '0')}`;

    const total = daily.wins + daily.losses;
    const winRate = total > 0 ? daily.wins / total : 0;
    const dailySuffix = winRate > 0.5 ? ` (Today: ${daily.wins}W / ${daily.losses}L 🔥)` : '';

    let description = `**${playerName}** has **${outcomeText}** the match! (${durationStr})${dailySuffix}\n${statLine}\n\n` +
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
