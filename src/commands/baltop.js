import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getTopUsers } from '../db.js';
import config from '../../config.js';

export const data = new SlashCommandBuilder()
  .setName('baltop')
  .setDescription('Show the top coin holders in this server');

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const top = getTopUsers(guildId, 10);

  if (top.length === 0) {
    return interaction.reply({ content: 'No users have collected coins yet.', ephemeral: true });
  }

  const lines = top.map((u, i) => {
    const medal = i < 3 ? ['🥇', '🥈', '🥉'][i] : `**${i + 1}.**`;
    const label = u.discord_id === config.house.id ? `**${config.house.label}**` : `<@${u.discord_id}>`;
    return `${medal} ${label} — ${u.coins.toLocaleString()} 🪙 (${u.correct}W/${u.incorrect}L)`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🏆 Coin Leaderboard')
    .setDescription(lines.join('\n'))
    .setColor(0xf1c40f);

  return interaction.reply({ embeds: [embed] });
}
