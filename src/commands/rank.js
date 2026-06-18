import { SlashCommandBuilder } from 'discord.js';
import { getRankedStatsByPuuid, getSummonerByPuuid, getApexCutoffs, getRiotCooldown, riotRateLimitMessage } from '../riot.js';
import { getTrackedPlayers, updatePeakRank, recordLp, getEarliestLpSince } from '../db.js';
import { displayName } from '../utils/displayName.js';
import { renderRankLadderPng } from '../matchGraph.js';
import { toAbsoluteLP } from '../utils/rankMath.js';

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

  // Pre-flight: bail with a clear message instead of starting work the
  // shared cooldown would only abort partway through.
  if (getRiotCooldown().cooling) {
    return interaction.reply({ content: riotRateLimitMessage(), ephemeral: true });
  }

  await interaction.deferReply();

  const ranked = [];
  const unranked = [];

  for (const player of players) {
    const entries = await getRankedStatsByPuuid(player.puuid, player.region);
    if (entries?.rateLimited) {
      return interaction.editReply({ content: riotRateLimitMessage() });
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

    // Profile icon — best-effort; the renderer falls back to a neutral tile.
    const summoner = await getSummonerByPuuid(player.puuid, player.region);
    const profileIconId = summoner?.profileIconId ?? null;

    // Weekly LP delta — compare the earliest lp_history entry from the last
    // 7 days against the current LP. null if no baseline exists yet.
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const baseline = getEarliestLpSince(guildId, player.puuid, sinceIso);
    let weeklyDelta = null;
    if (baseline) {
      const before = toAbsoluteLP(baseline.tier, baseline.rank, baseline.lp);
      const now = toAbsoluteLP(solo.tier, solo.rank, solo.leaguePoints);
      if (Number.isFinite(before) && Number.isFinite(now)) weeklyDelta = now - before;
    }

    ranked.push({
      puuid: player.puuid,
      riot_tag: player.riot_tag,
      region: player.region,
      tier: solo.tier,
      rank: solo.rank,
      lp: solo.leaguePoints,
      profileIconId,
      weeklyDelta,
    });
  }

  // Fetch live apex-tier cutoffs once per region (Master→GM and GM→Challenger
  // LP thresholds). getApexCutoffs caches for ~1h, so this is effectively free
  // on repeat /rank calls.
  const apexRegions = [...new Set(ranked
    .filter(r => ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(r.tier))
    .map(r => r.region)
  )];
  const cutoffsByRegion = {};
  await Promise.all(apexRegions.map(async (region) => {
    cutoffsByRegion[region] = await getApexCutoffs(region);
  }));
  for (const r of ranked) {
    if (cutoffsByRegion[r.region]) r.cutoffs = cutoffsByRegion[r.region];
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

  const content = unranked.length > 0
    ? `_Unranked / no data: ${unranked.map(p => displayName(p.riot_tag)).join(', ')}_`
    : undefined;

  // No embed — Discord renders the attachment at full native size, and the
  // PNG already shows "RANK LADDER" + "Tracked Players" in its header.
  return interaction.editReply({
    ...(content ? { content } : {}),
    files: [{ attachment: png, name: 'rank-ladder.png' }],
  });
}
