import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { ensureUser, getPerPlayerRecord, getUnlockedAchievements, ACHIEVEMENT_DEFS, getProfitHistory } from '../db.js';
import { displayName } from '../utils/displayName.js';
import { renderProfitPng } from '../matchGraph.js';

export const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Show your betting stats');

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const user = ensureUser(guildId, userId);

  const streakDisplay = user.current_streak > 0 ? `${user.current_streak} 🔥` : '0';
  const netProfit = user.total_won - user.total_wagered;
  const profitSign = netProfit >= 0 ? '+' : '';
  const profitColor = netProfit >= 0 ? '📈' : '📉';

  const embed = new EmbedBuilder()
    .setTitle(`📊 Stats for ${interaction.user.username}`)
    .addFields(
      { name: '🪙 Coins', value: user.coins.toLocaleString(), inline: true },
      { name: '🎯 Record', value: `${user.correct}W / ${user.incorrect}L`, inline: true },
      { name: '🔥 Streak', value: `${streakDisplay} (Best: ${user.best_streak})`, inline: true },
      { name: '💸 Total Wagered', value: user.total_wagered.toLocaleString(), inline: true },
      { name: '💰 Total Won', value: user.total_won.toLocaleString(), inline: true },
      { name: `${profitColor} Net Profit`, value: `${profitSign}${netProfit.toLocaleString()}`, inline: true },
    )
    .setColor(0x3498db);

  // Per-player betting record
  const records = getPerPlayerRecord(guildId, userId);
  if (records.length > 0) {
    const recordLines = records.map(r => {
      const name = r.riot_tag ? displayName(r.riot_tag) : 'Unknown';
      return `${name}: ${r.wins}W / ${r.losses}L (${r.total_wagered.toLocaleString()} 🪙)`;
    });
    embed.addFields({ name: '🎮 Per-Player Record', value: recordLines.join('\n'), inline: false });
  }

  // Achievements
  const unlocked = getUnlockedAchievements(guildId, userId);
  if (unlocked.length > 0) {
    const achMap = Object.fromEntries(ACHIEVEMENT_DEFS.map(d => [d.id, d.label]));
    const achLines = unlocked.map(id => achMap[id]).filter(Boolean);
    if (achLines.length > 0) {
      embed.addFields({ name: '🏆 Achievements', value: achLines.join('\n'), inline: false });
    }
  }

  // Cumulative profit chart — render only when the user has at least 2
  // resolved bets (need an arc, not just a point).
  let chartFile = null;
  try {
    const series = getProfitHistory(guildId, userId);
    if (series && series.length >= 3) {
      const pngBuf = await renderProfitPng(series);
      if (pngBuf) {
        chartFile = { attachment: pngBuf, name: 'profit.png' };
        embed.setImage('attachment://profit.png');
      }
    }
  } catch {
    // Falls through silently — stats embed always sends, with or without chart.
  }

  const payload = chartFile ? { embeds: [embed], files: [chartFile] } : { embeds: [embed] };
  return interaction.reply(payload);
}
