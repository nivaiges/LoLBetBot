import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getDuoPairs, resetDuoPair, getTrackedPlayerByTag } from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('duo')
  .setDescription('View duo win/loss records (auto-tracked when two tracked players are in the same game)')
  .addStringOption(opt =>
    opt.setName('reset')
      .setDescription('Reset a duo pair record: Player1#TAG,Player2#TAG')
      .setRequired(false)
  );

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const resetArg = interaction.options.getString('reset');

  if (resetArg) {
    const parts = resetArg.split(',').map(s => s.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return interaction.reply({ content: '❌ Format: `Player1#TAG,Player2#TAG`', ephemeral: true });
    }

    const p1 = getTrackedPlayerByTag(guildId, parts[0]);
    const p2 = getTrackedPlayerByTag(guildId, parts[1]);
    if (!p1) return interaction.reply({ content: `❌ **${parts[0]}** is not tracked.`, ephemeral: true });
    if (!p2) return interaction.reply({ content: `❌ **${parts[1]}** is not tracked.`, ephemeral: true });

    const result = resetDuoPair(guildId, p1.puuid, p2.puuid);
    if (result.changes === 0) {
      return interaction.reply({ content: `❌ No duo record found for **${parts[0]}** & **${parts[1]}**.`, ephemeral: true });
    }
    return interaction.reply(`✅ Reset duo record for **${parts[0]}** & **${parts[1]}** to 0W / 0L.`);
  }

  const pairs = getDuoPairs(guildId);
  if (!pairs.length) {
    return interaction.reply({
      content: 'No duo records yet. Duo stats are tracked automatically when two tracked players are in the same game.',
      ephemeral: true,
    });
  }

  const lines = pairs.map((p, i) => {
    const name1 = p.tag1 ? p.tag1.split('#')[0] : 'Unknown';
    const name2 = p.tag2 ? p.tag2.split('#')[0] : 'Unknown';
    const total = p.wins + p.losses;
    const winRate = total > 0 ? ((p.wins / total) * 100).toFixed(1) : '0.0';
    return `${i + 1}. **${name1}** & **${name2}** — ${p.wins}W / ${p.losses}L (${winRate}%)`;
  });

  const embed = new EmbedBuilder()
    .setTitle('👥 Duo Records')
    .setDescription(lines.join('\n'))
    .setColor(0x3498db);

  return interaction.reply({ embeds: [embed] });
}
