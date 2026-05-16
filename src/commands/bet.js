import { SlashCommandBuilder } from 'discord.js';
import {
  ensureUser,
  getTrackedPlayers,
  getActiveMatch,
  getUserBetOnMatch,
  deductCoins,
  addCoins,
  placeBet,
  updateBet,
  updateCollect,
} from '../db.js';
import { isBettingOpen } from '../utils/bettingwindow.js';
import config from '../../config.js';
import { displayTag } from '../utils/displayName.js';

function tryAutoCollect(guildId, userId, user) {
  const now = new Date();
  if (user.last_collect_at) {
    const lastCollect = new Date(user.last_collect_at + 'Z');
    const elapsed = now.getTime() - lastCollect.getTime();
    if (elapsed < config.collectCooldownMs) return null;
  }
  const newCoins = user.coins + config.collectAmount;
  updateCollect(guildId, userId, newCoins, now.toISOString().replace('T', ' ').slice(0, 19));
  return newCoins;
}

export const data = new SlashCommandBuilder()
  .setName('bet')
  .setDescription('Bet on a tracked player\'s current match')
  .addStringOption(opt =>
    opt.setName('prediction')
      .setDescription('Will the tracked player win or lose?')
      .setRequired(true)
      .addChoices(
        { name: 'Win', value: 'win' },
        { name: 'Lose', value: 'lose' },
      )
  )
  .addIntegerOption(opt =>
    opt.setName('amount')
      .setDescription('Amount of coins to bet')
      .setRequired(true)
      .setMinValue(1)
  )
  .addStringOption(opt =>
    opt.setName('player')
      .setDescription('Riot ID of the tracked player (optional if only one tracked)')
      .setRequired(false)
  );

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const prediction = interaction.options.getString('prediction');
  const amount = interaction.options.getInteger('amount');
  const playerArg = interaction.options.getString('player');

  const user = ensureUser(guildId, userId);

  // Resolve tracked player
  const tracked = getTrackedPlayers(guildId);
  if (tracked.length === 0) {
    return interaction.reply({ content: 'No tracked players in this server. Use `/adduser` first.', ephemeral: true });
  }

  let target;
  if (playerArg) {
    target = tracked.find(p => p.riot_tag.toLowerCase() === playerArg.toLowerCase());
    if (!target) {
      return interaction.reply({ content: `Player **${playerArg}** is not tracked. Use \`/adduser\` to add them.`, ephemeral: true });
    }
  } else if (tracked.length === 1) {
    target = tracked[0];
  } else {
    const names = tracked.map(p => displayTag(p.riot_tag)).join(', ');
    return interaction.reply({ content: `Multiple tracked players: ${names}. Specify one with the \`player\` option.`, ephemeral: true });
  }

  // Check active match
  const match = getActiveMatch(guildId, target.puuid);
  if (!match) {
    return interaction.reply({ content: `❌ **${displayTag(target.riot_tag)}** is not currently in an active match.`, ephemeral: true });
  }

  // Check betting window
  if (!isBettingOpen(match.match_id)) {
    return interaction.reply({ content: '🔒 Betting is closed for this match (3-minute window expired).', ephemeral: true });
  }

  // Check balance — auto-collect if cooldown is up
  let autoCollected = false;
  if (user.coins < amount) {
    const collected = tryAutoCollect(guildId, userId, user);
    if (collected !== null) {
      user.coins = collected;
      autoCollected = true;
    }
    if (user.coins < amount) {
      return interaction.reply({ content: `Insufficient coins. You have **${user.coins.toLocaleString()}** coins.`, ephemeral: true });
    }
  }

  // Check existing bet — allow updating during betting window
  const existingBet = getUserBetOnMatch(guildId, userId, match.match_id);
  if (existingBet) {
    // Refund old bet, deduct new amount
    addCoins(guildId, userId, existingBet.amount);
    const refreshed = ensureUser(guildId, userId);
    if (refreshed.coins < amount) {
      // Undo refund if they can't afford the new bet
      deductCoins(guildId, userId, existingBet.amount);
      return interaction.reply({ content: `Insufficient coins. You have **${(refreshed.coins - existingBet.amount).toLocaleString()}** coins (plus ${existingBet.amount.toLocaleString()} in your current bet).`, ephemeral: true });
    }
    deductCoins(guildId, userId, amount);
    updateBet(existingBet.id, prediction, amount);

    const changed = existingBet.prediction !== prediction
      ? ` (changed from ${existingBet.prediction.toUpperCase()})`
      : '';
    return interaction.reply(
      `Bet updated: **${prediction.toUpperCase()}** on **${displayTag(target.riot_tag)}** for **${amount.toLocaleString()}** coins${changed}. (was ${existingBet.amount.toLocaleString()} coins)`
    );
  }

  // Place new bet
  deductCoins(guildId, userId, amount);
  placeBet(guildId, userId, match.match_id, target.puuid, prediction, amount);

  const collectNote = autoCollected ? `\n🪙 Auto-collected **${config.collectAmount.toLocaleString()}** coins!` : '';
  return interaction.reply(
    `Bet placed: **${prediction.toUpperCase()}** on **${displayTag(target.riot_tag)}** for **${amount.toLocaleString()}** coins.${collectNote}`
  );
}
