import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import {
  getTrackedPlayers,
  getTrackedPlayerByTag,
  ensureUser,
  setAutoBet,
  removeAutoBet,
  getAutoBets,
} from '../db.js';
import { displayTag } from '../utils/displayName.js';

export const data = new SlashCommandBuilder()
  .setName('autobet')
  .setDescription('Auto-bet on a tracked player whenever they enter a match')
  .addSubcommand(sub =>
    sub.setName('view')
      .setDescription('Show your active auto-bets'))
  .addSubcommand(sub =>
    sub.setName('set')
      .setDescription('Set (or update) an auto-bet on a tracked player')
      .addStringOption(opt =>
        opt.setName('player').setDescription('Tracked player').setAutocomplete(true).setRequired(true))
      .addStringOption(opt =>
        opt.setName('prediction').setDescription('win or lose').addChoices(
          { name: 'Win',  value: 'win'  },
          { name: 'Lose', value: 'lose' },
        ).setRequired(true))
      .addIntegerOption(opt =>
        opt.setName('amount').setDescription('Coins to bet each game').setMinValue(1).setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('clear')
      .setDescription('Remove an auto-bet')
      .addStringOption(opt =>
        opt.setName('player').setDescription('Player with an active auto-bet').setAutocomplete(true).setRequired(true)));

export async function autocomplete(interaction) {
  const sub = interaction.options.getSubcommand();
  const focused = (interaction.options.getFocused() || '').toLowerCase();
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  // `clear` only lists players the user actually has an auto-bet for —
  // `set` lists every tracked player so you can add a new one.
  const pool = sub === 'clear'
    ? getAutoBets(guildId, userId).map(ab => ab.riot_tag)
    : getTrackedPlayers(guildId).map(tp => tp.riot_tag);

  const matches = pool
    .filter(tag => tag.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(tag => ({ name: displayTag(tag), value: tag }));
  await interaction.respond(matches);
}

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'view') {
    const autoBets = getAutoBets(guildId, userId);
    if (!autoBets.length) {
      return interaction.reply({
        content: 'You have no active auto-bets. Use `/autobet set player:Name#TAG prediction:win amount:5000` to set one.',
        ephemeral: true,
      });
    }
    const lines = autoBets.map(ab => {
      const emoji = ab.prediction === 'win' ? '🟢' : '🔴';
      return `${emoji} **${displayTag(ab.riot_tag)}** — ${ab.prediction.toUpperCase()} for **${ab.amount.toLocaleString()}** 🪙`;
    });
    const embed = new EmbedBuilder()
      .setTitle('🤖 Your Auto-Bets')
      .setDescription(lines.join('\n'))
      .setColor(0x3498db);
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'clear') {
    const playerTag = interaction.options.getString('player');
    const tracked = getTrackedPlayerByTag(guildId, playerTag);
    if (!tracked) {
      return interaction.reply({ content: `❌ Player **${playerTag}** is not tracked in this server.`, ephemeral: true });
    }
    const result = removeAutoBet(guildId, userId, tracked.puuid);
    if (result.changes === 0) {
      return interaction.reply({ content: `⚠️ You don't have an auto-bet on **${displayTag(tracked.riot_tag)}**.`, ephemeral: true });
    }
    return interaction.reply({ content: `✅ Auto-bet removed for **${displayTag(tracked.riot_tag)}**.`, ephemeral: true });
  }

  // sub === 'set'
  const playerTag = interaction.options.getString('player');
  const prediction = interaction.options.getString('prediction');
  const amount = interaction.options.getInteger('amount');

  const tracked = getTrackedPlayerByTag(guildId, playerTag);
  if (!tracked) {
    return interaction.reply({ content: `❌ Player **${playerTag}** is not tracked in this server.`, ephemeral: true });
  }

  ensureUser(guildId, userId);
  setAutoBet(guildId, userId, tracked.puuid, prediction, amount);

  const emoji = prediction === 'win' ? '🟢' : '🔴';
  return interaction.reply({
    content: `${emoji} Auto-bet set: **${prediction.toUpperCase()}** for **${amount.toLocaleString()}** 🪙 on **${displayTag(tracked.riot_tag)}** every game.`,
    ephemeral: true,
  });
}
