import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getTrackedPlayers, getTrackedPlayerByTag, getLpHistory } from '../db.js';
import { renderLpPng } from '../matchGraph.js';
import { displayTag, displayName } from '../utils/displayName.js';

export const data = new SlashCommandBuilder()
  .setName('lp')
  .setDescription('Show a tracked player\'s LP history graph')
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
    // Default to the first tracked player who has LP history rows
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

  const pngBuf = await renderLpPng(history, { title: `${displayName(target.riot_tag)} — LP History` });
  if (!pngBuf) {
    return interaction.reply({ content: '❌ Failed to render LP graph.', ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setTitle(`📈 ${displayTag(target.riot_tag)} — LP History`)
    .setDescription(`Last **${history.length}** rank-check data points.`)
    .setColor(0x3498db)
    .setImage('attachment://lp.png');

  return interaction.reply({
    embeds: [embed],
    files: [{ attachment: pngBuf, name: 'lp.png' }],
  });
}
