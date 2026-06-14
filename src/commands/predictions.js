import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getOpenPredict10ForUser, getTrackedPlayers } from '../db.js';
import { displayTag } from '../utils/displayName.js';

export const data = new SlashCommandBuilder()
  .setName('predictions')
  .setDescription('Show your open /predict10 bets and their progress');

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const open = getOpenPredict10ForUser(guildId, userId);
  if (open.length === 0) {
    return interaction.reply({
      content: 'You have no open predictions. Use `/predict10` to place one.',
      ephemeral: true,
    });
  }

  const players = getTrackedPlayers(guildId);
  const tagFor = (puuid) => {
    const p = players.find(x => x.puuid === puuid);
    return p ? displayTag(p.riot_tag) : 'unknown player';
  };

  const lines = open.map(b => {
    const remaining = 10 - b.games_played;
    return `• **${tagFor(b.target_puuid)}** — predicted **${b.predicted_wins}**W, currently **${b.wins_so_far}W in ${b.games_played}/10** (${remaining} to go) · ${b.amount.toLocaleString()} 🪙`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🎯 Your Open Predictions')
    .setDescription(lines.join('\n'))
    .setColor(0x9b59b6);
  return interaction.reply({ embeds: [embed], ephemeral: true });
}
