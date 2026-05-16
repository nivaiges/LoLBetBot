import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getRankedStatsByPuuid } from '../riot.js';
import { getTrackedPlayers, isEmojiEnabled, updatePeakRank, recordLp } from '../db.js';
import config from '../../config.js';
import { displayTag } from '../utils/displayName.js';

const TIER_ORDER = [
  'CHALLENGER', 'GRANDMASTER', 'MASTER',
  'DIAMOND', 'EMERALD', 'PLATINUM', 'GOLD',
  'SILVER', 'BRONZE', 'IRON',
];
const RANK_ORDER = ['I', 'II', 'III', 'IV'];

function tierValue(tier, rank, lp) {
  const t = TIER_ORDER.indexOf(tier);
  const r = RANK_ORDER.indexOf(rank);
  // Lower index = higher rank. Invert so higher value = better.
  return (TIER_ORDER.length - t) * 10000 + (RANK_ORDER.length - r) * 100 + lp;
}

// Converts a rank to a continuous LP value for gap calculations.
// Each tier = 400 LP (4 divisions × 100).
// Master/GM/Challenger share a single LP pool starting just above Diamond I —
// do NOT add tier offsets between them, just use a fixed base of 2800.
const TIERS_ASC = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVS = ['IV', 'III', 'II', 'I'];
const MASTER_PLUS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

function toAbsoluteLP(tier, rank, lp) {
  const ti = TIERS_ASC.indexOf(tier);
  if (ti < 0) return null;
  if (ti >= 7) return 2800 + (lp || 0); // Master+ share one continuous pool
  const di = Math.max(0, DIVS.indexOf(rank));
  return ti * 400 + di * 100 + (lp || 0);
}

// Matches rankToValue in poller.js — required by updatePeakRank.
function rankToValue(tier, division) {
  const ti = TIERS_ASC.indexOf(tier);
  if (ti < 0) return null;
  if (ti >= 7) return ti * 4;
  return ti * 4 + DIVS.indexOf(division);
}

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Show ranks of all tracked players');

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const players = getTrackedPlayers(guildId);

  if (!players.length) {
    return interaction.reply({ content: 'No tracked players. Use `/adduser` to add some.', ephemeral: true });
  }

  await interaction.deferReply();

  const results = [];

  for (const player of players) {
    const entries = await getRankedStatsByPuuid(player.puuid, player.region);
    if (!entries || entries.rateLimited) {
      if (entries?.rateLimited) {
        results.push({ tag: displayTag(player.riot_tag), rank: null, error: 'Rate limited' });
        break;
      }
      results.push({ tag: displayTag(player.riot_tag), rank: null });
      continue;
    }

    const solo = Array.isArray(entries) && entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
    if (!solo) {
      results.push({ tag: displayTag(player.riot_tag), rank: null });
    } else {
      const rv = rankToValue(solo.tier, solo.rank);
      const currAbsLP = toAbsoluteLP(solo.tier, solo.rank, solo.leaguePoints);
      const prevPeakAbsLP = player.peak_tier
        ? toAbsoluteLP(player.peak_tier, player.peak_rank, player.peak_lp)
        : null;
      const isNewPeak = rv !== null && currAbsLP != null
        && (prevPeakAbsLP == null || currAbsLP > prevPeakAbsLP);
      if (rv !== null) {
        updatePeakRank(guildId, player.puuid, solo.tier, solo.rank, solo.leaguePoints, rv);
        recordLp(guildId, player.puuid, solo.tier, solo.rank, solo.leaguePoints, null);
      }

      const value = tierValue(solo.tier, solo.rank, solo.leaguePoints);
      const total = solo.wins + solo.losses;
      const winRate = total > 0 ? ((solo.wins / total) * 100).toFixed(1) : '0.0';
      const result = {
        tag: displayTag(player.riot_tag),
        tier: solo.tier,
        rank: MASTER_PLUS.has(solo.tier) ? solo.tier : `${solo.tier} ${solo.rank}`,
        lp: solo.leaguePoints,
        record: `${solo.wins}W / ${solo.losses}L (${winRate}%)`,
        value,
        newPeak: isNewPeak,
      };

      // Peak distance — only when peak is recorded and player is currently below it
      if (player.peak_tier) {
        const peakAbsLP = prevPeakAbsLP;
        const gap = peakAbsLP - currAbsLP;
        if (gap > 0) {
          result.peakGapLP = gap;
          result.peakWins = Math.ceil(gap / 20);
          const peakRankStr = MASTER_PLUS.has(player.peak_tier)
            ? player.peak_tier
            : `${player.peak_tier} ${player.peak_rank}`;
          result.peakLabel = `${peakRankStr} (${player.peak_lp} LP)`;
        }
      }

      results.push(result);
    }
  }

  // Sort ranked players first (by value desc), then unranked at bottom
  results.sort((a, b) => {
    if (a.value != null && b.value != null) return b.value - a.value;
    if (a.value != null) return -1;
    if (b.value != null) return 1;
    return 0;
  });

  const emojiOn = isEmojiEnabled(guildId);
  const lines = results.map((r, i) => {
    const pos = `${i + 1}.`;
    if (r.rank) {
      const emoji = emojiOn ? config.getRankEmoji(r.tier) : '';
      const prefix = emoji ? `${emoji} ` : '';
      let line = `${pos} ${prefix}**${r.tag}** — ${r.rank} (${r.lp} LP) • ${r.record}`;
      if (r.newPeak) {
        line += `\n　🏆 **New peak!** ${r.rank} (${r.lp} LP)`;
      }
      if (r.peakGapLP) {
        line += `\n　📉 ${r.peakGapLP} LP from peak (${r.peakLabel}) — ~${r.peakWins} wins to recover`;
      }
      return line;
    }
    return `${pos} **${r.tag}** — Unranked`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Tracked Players — Solo/Duo Ranks')
    .setDescription(lines.join('\n'))
    .setColor(0x9b59b6);

  return interaction.editReply({ embeds: [embed] });
}
