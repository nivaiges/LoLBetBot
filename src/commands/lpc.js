import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getTrackedPlayers, getTrackedPlayerByTag, getLpHistory } from '../db.js';
import { renderLpComparePng, compareColor } from '../matchGraph.js';
import { displayTag, displayName } from '../utils/displayName.js';
import { rankLabel } from '../utils/rankMath.js';

const MAX_PLAYERS = 10;
const SLOT_COUNT = 8;

export const data = (() => {
  const b = new SlashCommandBuilder()
    .setName('lpc')
    .setDescription('Compare LP history across multiple tracked players (stacked on one chart)');
  for (let i = 1; i <= SLOT_COUNT; i++) {
    b.addStringOption(opt =>
      opt.setName(`player${i}`)
        .setDescription(`Player ${i} (Name#TAG). Leave all empty to compare every tracked player with history.`)
        .setAutocomplete(true)
        .setRequired(false)
    );
  }
  return b;
})();

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

  // Collect requested player tags (in order)
  const requested = [];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const v = interaction.options.getString(`player${i}`);
    if (v) requested.push(v);
  }

  // Resolve to tracked rows. If none requested, default to all tracked
  // players with history.
  let targets = [];
  if (requested.length > 0) {
    for (const tag of requested) {
      const tp = getTrackedPlayerByTag(guildId, tag);
      if (!tp) {
        return interaction.reply({ content: `❌ Player **${tag}** is not tracked.`, ephemeral: true });
      }
      // Dedup by puuid
      if (!targets.some(t => t.puuid === tp.puuid)) targets.push(tp);
    }
  } else {
    const all = getTrackedPlayers(guildId);
    for (const p of all) {
      if (getLpHistory(guildId, p.puuid, 1).length > 0) targets.push(p);
      if (targets.length >= MAX_PLAYERS) break;
    }
  }

  if (targets.length === 0) {
    return interaction.reply({ content: 'No tracked players with LP history yet. Run `/rank` to seed entries.', ephemeral: true });
  }
  if (targets.length === 1) {
    return interaction.reply({ content: 'Need at least 2 players to compare. Use `/lp` for a single-player graph.', ephemeral: true });
  }
  if (targets.length > MAX_PLAYERS) targets = targets.slice(0, MAX_PLAYERS);

  // Fetch history per target
  const players = targets.map(tp => ({
    riotTag: tp.riot_tag,
    entries: getLpHistory(guildId, tp.puuid),
  }));

  const withHistory = players.filter(p => p.entries.length > 0);
  if (withHistory.length < 2) {
    return interaction.reply({ content: 'Need at least 2 players with LP history to compare.', ephemeral: true });
  }

  const png = await renderLpComparePng(withHistory, { title: 'LP Comparison' });
  if (!png) {
    return interaction.reply({ content: '❌ Failed to render comparison.', ephemeral: true });
  }

  // Legend: colored dot + name + current rank
  const legend = withHistory.map((p, i) => {
    const last = p.entries[p.entries.length - 1];
    const dot = compareDot(i);
    return `${dot} **${displayName(p.riotTag)}** — ${rankLabel(last.tier, last.rank, last.lp)} (${p.entries.length} entries)`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`📊 LP Comparison — ${withHistory.length} players`)
    .setDescription(legend)
    .setColor(0x3498db)
    .setImage('attachment://lp-compare.png');

  return interaction.reply({
    embeds: [embed],
    files: [{ attachment: png, name: 'lp-compare.png' }],
  });
}

// Map compareColor() hex to the closest Unicode color dot for the legend.
const COLOR_DOTS = ['🔵', '🟢', '🟠', '🟣', '🔴', '🟡'];
function compareDot(i) {
  return COLOR_DOTS[i % COLOR_DOTS.length];
}
