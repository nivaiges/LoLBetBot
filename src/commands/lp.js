import { SlashCommandBuilder } from 'discord.js';
import { getTrackedPlayers, getTrackedPlayerByTag, getLpHistory } from '../db.js';
import { getSummonerByPuuid, getRankedStatsByPuuid, getApexCutoffs, getTopChampion, loadChampionMap, getChampionInternalId, getRiotCooldown, riotRateLimitMessage } from '../riot.js';
import { renderLpProfilePng } from '../matchGraph.js';
import { displayTag } from '../utils/displayName.js';

export const data = new SlashCommandBuilder()
  .setName('lp')
  .setDescription('Show a tracked player\'s LP profile + history graph')
  .addStringOption(opt =>
    opt.setName('player')
      .setDescription('Riot tag (e.g. Name#TAG) — defaults to the first tracked player with data')
      .setAutocomplete(true)
      .setRequired(false)
  );

export async function autocomplete(interaction) {
  const players = getTrackedPlayers(interaction.guildId);
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = players
    .map(p => p.riot_tag)
    .filter(t => t.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(t => ({ name: displayTag(t), value: t }));
  await interaction.respond(matches);
}

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const requested = interaction.options.getString('player');

  let target;
  if (requested) {
    target = getTrackedPlayerByTag(guildId, requested);
    if (!target) {
      return interaction.reply({ content: `❌ Player **${requested}** is not tracked.`, ephemeral: true });
    }
  } else {
    const all = getTrackedPlayers(guildId);
    for (const p of all) {
      if (getLpHistory(guildId, p.puuid, 1).length > 0) { target = p; break; }
    }
    if (!target) {
      return interaction.reply({ content: 'No LP history recorded yet. The bot starts logging on each tracked match. Try `/rank` to seed an entry.', ephemeral: true });
    }
  }

  const history = getLpHistory(guildId, target.puuid);
  if (history.length === 0) {
    return interaction.reply({ content: `No LP history yet for **${displayTag(target.riot_tag)}**. Try \`/rank\` to seed an entry.`, ephemeral: true });
  }
  if (history.length < 2) {
    return interaction.reply({ content: `Only 1 LP data point recorded for **${displayTag(target.riot_tag)}** so far — need at least 2 for a graph.`, ephemeral: true });
  }

  if (getRiotCooldown().cooling) {
    return interaction.reply({ content: riotRateLimitMessage(), ephemeral: true });
  }

  await interaction.deferReply();

  // Fetch summoner (icon + level), current ranked stats (W/L), and the
  // player's top champion (used as a faded background graphic on the header).
  // All are best-effort — the renderer degrades gracefully on misses.
  await loadChampionMap();
  const [summoner, rankedEntries, topChampionId] = await Promise.all([
    getSummonerByPuuid(target.puuid, target.region),
    getRankedStatsByPuuid(target.puuid, target.region),
    getTopChampion(target.puuid, target.region),
  ]);
  if (summoner?.rateLimited || rankedEntries?.rateLimited) {
    return interaction.editReply({ content: riotRateLimitMessage() });
  }
  const topChampionInternalId = topChampionId != null ? getChampionInternalId(topChampionId) : null;
  const solo = Array.isArray(rankedEntries)
    ? rankedEntries.find(e => e.queueType === 'RANKED_SOLO_5x5')
    : null;

  // Use the freshest tier/rank/lp/wins/losses we have. Fall back to the last
  // lp_history row if Riot's response was thin (e.g. unranked window).
  const lastHistory = history[history.length - 1];
  const tier = solo?.tier || lastHistory.tier;
  const rank = solo?.rank || lastHistory.rank;
  const lp = solo?.leaguePoints ?? lastHistory.lp;
  const wins = solo?.wins ?? 0;
  const losses = solo?.losses ?? 0;

  // Apex cutoffs (for "X LP to GRANDMASTER" on the progress bar). Only fetch
  // if the player is Master+, since the call is the ~2MB pool.
  let cutoffs = null;
  if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier)) {
    cutoffs = await getApexCutoffs(target.region);
  }

  const png = await renderLpProfilePng({
    riotTag: target.riot_tag,
    summonerLevel: summoner?.summonerLevel ?? null,
    profileIconId: summoner?.profileIconId ?? null,
    tier, rank, lp, wins, losses,
    entries: history,
    cutoffs,
    topChampionInternalId,
  });
  if (!png) {
    return interaction.editReply({ content: '❌ Failed to render LP profile.' });
  }

  // No embed — full native attachment width, matching /rank and Match Over.
  return interaction.editReply({
    files: [{ attachment: png, name: 'lp.png' }],
  });
}
