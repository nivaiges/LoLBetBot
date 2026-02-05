import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show all available commands');

export async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('📖 Bet Bot Commands')
    .setDescription([
      '`/collect` — Collect 10,000 coins (2h cooldown)',
      '`/bet <win|lose> <amount> [player]` — Bet on a match (WIN 1.5x · LOSE 3x)',
      '`/autobet [player] [prediction] [amount]` — Auto-bet every game (no args to view)',
      '`/autobet player:Name#TAG clear:True` — Remove an auto-bet',
      '`/give <@user> <amount>` — Give coins to another user',
      '`/baltop` — Coin leaderboard',
      '`/stats` — Your stats, streak, record, and achievements',
      '`/history` — Your last 10 bets with outcomes',
      '`/achievements` — Achievement progress with progress bars',
      '`/rank` — Tracked players\' current Solo/Duo ranks',
      '`/peak` — Tracked players\' peak Solo/Duo ranks',
      '`/adduser <GameName#TagLine>` — Track a League player',
      '`/removeuser <GameName#TagLine>` — Stop tracking a player',
      '`/emoji <on|off>` — Toggle rank emojis on/off',
      '`/bethere` — Set the channel for betting notifications',
    ].join('\n'))
    .setColor(0x3498db);

  return interaction.reply({ embeds: [embed], ephemeral: true });
}
