import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getRankedStatsByPuuid } from '../riot.js';
import { getTrackedPlayers, updatePeakRank, recordLp } from '../db.js';
import { displayName } from '../utils/displayName.js';
import { renderRankLadderPng } from '../matchGraph.js';

const TIERS_ASC = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVS = ['IV', 'III', 'II', 'I'];

function rankToValue(tier, division) {
  const ti = TIERS_ASC.indexOf(tier);
  if (ti < 0) return null;
  if (ti >= 7) return ti * 4;
  return ti * 4 + DIVS.indexOf(division);
}

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Fetch fresh ranks from Riot and render the ladder chart');

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const players = getTrackedPlayers(guildId);

  if (!players.length) {
    return interaction.reply({ content: 'No tracked players. Use `/adduser` to add some.', ephemeral: true });
  }

  await interaction.deferReply();

  const ranked = [];
  const unranked = [];

  for (const player of players) {
    const entries = await getRankedStatsByPuuid(player.puuid, player.region);
    if (entries?.rateLimited) {
      return interaction.editReply({ content: '⏳ Riot API is rate-limiting us right now. Try again in a few seconds.' });
    }
    if (!entries) {
      unranked.push(player);
      continue;
    }

    const solo = Array.isArray(entries) && entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
    if (!solo) {
      unranked.push(player);
      continue;
    }

    const rv = rankToValue(solo.tier, solo.rank);
    if (rv !== null) {
      updatePeakRank(guildId, player.puuid, solo.tier, solo.rank, solo.leaguePoints, rv);
      recordLp(guildId, player.puuid, solo.tier, solo.rank, solo.leaguePoints, null);
    }

    ranked.push({
      puuid: player.puuid,
      riot_tag: player.riot_tag,
      tier: solo.tier,
      rank: solo.rank,
      lp: solo.leaguePoints,
    });
  }

  if (ranked.length === 0) {
    return interaction.editReply({ content: 'No tracked players have a Solo/Duo rank yet.' });
  }

  // Re-pull tracked rows so peak_* reflects any updates from this run.
  const fresh = new Map(getTrackedPlayers(guildId).map(p => [p.puuid, p]));
  for (const r of ranked) {
    const f = fresh.get(r.puuid);
    if (f) {
      r.peak_tier = f.peak_tier;
      r.peak_rank = f.peak_rank;
      r.peak_lp = f.peak_lp;
    }
  }

  const png = await renderRankLadderPng(ranked, {
    title: 'Tracked Players — Rank Ladder',
    decorateFirstLast: true, // 👑 on first place, 🥀 on last place — /rank only
  });
  if (!png) {
    return interaction.editReply({ content: '❌ Failed to render the rank ladder.' });
  }

  const embed = new EmbedBuilder()
    .setTitle('📊 Tracked Players — Solo/Duo Ranks (live)')
    .setColor(0x9b59b6);

  if (unranked.length > 0) {
    embed.setDescription(`_Unranked / no data: ${unranked.map(p => displayName(p.riot_tag)).join(', ')}_`);
  }

  // Chart attached at top level (no embed.setImage) so Discord renders it
  // at the bigger native attachment size beneath the embed.
  return interaction.editReply({
    embeds: [embed],
    files: [{ attachment: png, name: 'rank-ladder.png' }],
  });
}
