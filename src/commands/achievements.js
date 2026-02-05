import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { ensureUser, getUnlockedAchievements, ACHIEVEMENT_DEFS } from '../db.js';

function progressBar(current, target) {
  const pct = Math.min(current / target, 1);
  const filled = Math.round(pct * 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${current}/${target}`;
}

function getProgress(user, achId) {
  const [category, numStr] = achId.split('_');
  const target = parseInt(numStr, 10);
  let current;
  if (category === 'bets') current = user.correct + user.incorrect;
  else if (category === 'wins') current = user.correct;
  else if (category === 'streak') current = user.best_streak;
  else return null;
  return { current: Math.min(current, target), target };
}

export const data = new SlashCommandBuilder()
  .setName('achievements')
  .setDescription('Show achievement progress');

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const user = ensureUser(guildId, userId);
  const unlocked = new Set(getUnlockedAchievements(guildId, userId));

  const sections = {
    'Bets Placed': ACHIEVEMENT_DEFS.filter(d => d.id.startsWith('bets_')),
    'Bets Won': ACHIEVEMENT_DEFS.filter(d => d.id.startsWith('wins_')),
    'Win Streak': ACHIEVEMENT_DEFS.filter(d => d.id.startsWith('streak_')),
  };

  const fields = [];
  for (const [title, defs] of Object.entries(sections)) {
    const lines = defs.map(d => {
      const done = unlocked.has(d.id);
      const prog = getProgress(user, d.id);
      if (!prog) return null;
      const check = done ? '✅' : '⬜';
      const bar = done ? `${prog.target}/${prog.target}` : progressBar(prog.current, prog.target);
      // Extract the name part (e.g. "Gambler" from "🎰 Gambler — 10 bets placed")
      const namePart = d.label.split(' — ')[0];
      return `${check} ${namePart} — ${bar}`;
    }).filter(Boolean);
    fields.push({ name: title, value: lines.join('\n'), inline: false });
  }

  const total = ACHIEVEMENT_DEFS.length;
  const done = unlocked.size;

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Achievements — ${interaction.user.username}`)
    .setDescription(`**${done}/${total}** unlocked`)
    .addFields(fields)
    .setColor(done === total ? 0xf1c40f : 0x3498db);

  return interaction.reply({ embeds: [embed] });
}
