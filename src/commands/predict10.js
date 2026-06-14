import { SlashCommandBuilder } from 'discord.js';
import {
  getTrackedPlayers, getTrackedPlayerByTag, ensureUser, deductCoins,
  createPredict10, getOpenPredict10ForUserAndPlayer, getUser,
} from '../db.js';
import { displayTag } from '../utils/displayName.js';
import logger from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('predict10')
  .setDescription('Bet on how many of a player\'s next 10 games they\'ll win')
  .addStringOption(opt =>
    opt.setName('player').setDescription('Tracked player')
      .setAutocomplete(true).setRequired(true));

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

// In-memory state for the dropdown flow: (userId, puuid) → partial bet info.
// Cleared on confirm; ephemeral interactions expire in 15min anyway.
const state = new Map();
const stateKey = (userId, puuid) => `${userId}:${puuid}`;

const AMOUNT_OPTIONS = [
  { label: '100 🪙', value: '100' },
  { label: '500 🪙', value: '500' },
  { label: '1,000 🪙', value: '1000' },
  { label: '5,000 🪙', value: '5000' },
  { label: '25,000 🪙', value: '25000' },
  { label: '50,000 🪙', value: '50000' },
];

function buildComponents(puuid, partial = {}) {
  const winsOptions = Array.from({ length: 11 }, (_, i) => ({
    label: `${i} wins / 10`,
    value: String(i),
    description: i === 0 ? 'Predicted to lose all 10'
      : i === 10 ? 'Sweep — wins all 10'
      : `${i}W / ${10 - i}L`,
    default: partial.wins === i,
  }));
  const amountOptions = AMOUNT_OPTIONS.map(o => ({
    ...o,
    default: partial.amount === parseInt(o.value, 10),
  }));
  const ready = partial.wins != null && partial.amount != null;
  return [
    { type: 1, components: [{ type: 3, custom_id: `predict10_wins_${puuid}`, placeholder: 'How many wins out of 10?', options: winsOptions }] },
    { type: 1, components: [{ type: 3, custom_id: `predict10_amount_${puuid}`, placeholder: 'Bet amount', options: amountOptions }] },
    { type: 1, components: [{ type: 2, style: 1, custom_id: `predict10_confirm_${puuid}`, label: '🎯 Confirm prediction', disabled: !ready }] },
  ];
}

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const playerTag = interaction.options.getString('player');

  const target = getTrackedPlayerByTag(guildId, playerTag);
  if (!target) {
    return interaction.reply({ content: `❌ Player **${playerTag}** is not tracked.`, ephemeral: true });
  }

  const existing = getOpenPredict10ForUserAndPlayer(guildId, userId, target.puuid);
  if (existing) {
    return interaction.reply({
      content: `❌ You already have an open prediction on **${displayTag(target.riot_tag)}** — ${existing.wins_so_far}W in ${existing.games_played}/10. Wait for it to settle.`,
      ephemeral: true,
    });
  }

  // Seed fresh state for this attempt.
  state.set(stateKey(userId, target.puuid), { guildId, puuid: target.puuid, riotTag: target.riot_tag });

  return interaction.reply({
    content: `🎯 Predicting on **${displayTag(target.riot_tag)}** — pick wins and bet amount:`,
    components: buildComponents(target.puuid),
    ephemeral: true,
  });
}

// Route component interactions (selects + confirm button) from index.js.
// Returns true if it handled the interaction.
export async function handleComponent(interaction) {
  const id = interaction.customId;
  if (!id?.startsWith('predict10_')) return false;
  const userId = interaction.user.id;

  if (interaction.isStringSelectMenu()) {
    if (id.startsWith('predict10_wins_') || id.startsWith('predict10_amount_')) {
      const isWins = id.startsWith('predict10_wins_');
      const puuid = id.slice((isWins ? 'predict10_wins_' : 'predict10_amount_').length);
      const key = stateKey(userId, puuid);
      const partial = state.get(key);
      if (!partial) {
        return interaction.reply({ content: '⌛ This selector expired. Run `/predict10` again.', ephemeral: true });
      }
      if (isWins) partial.wins = parseInt(interaction.values[0], 10);
      else partial.amount = parseInt(interaction.values[0], 10);
      state.set(key, partial);
      await interaction.update({ components: buildComponents(puuid, partial) });
      return true;
    }
  }

  if (interaction.isButton() && id.startsWith('predict10_confirm_')) {
    const puuid = id.slice('predict10_confirm_'.length);
    const key = stateKey(userId, puuid);
    const partial = state.get(key);
    if (!partial || partial.wins == null || partial.amount == null) {
      return interaction.reply({ content: '❌ Pick both wins and amount first.', ephemeral: true });
    }

    const { guildId, riotTag, wins, amount } = partial;

    // Re-check coins + existing prediction at confirm time.
    const user = ensureUser(guildId, userId);
    if (user.coins < amount) {
      return interaction.reply({
        content: `❌ Not enough coins — you have **${user.coins.toLocaleString()}** 🪙, need **${amount.toLocaleString()}**.`,
        ephemeral: true,
      });
    }
    if (getOpenPredict10ForUserAndPlayer(guildId, userId, puuid)) {
      return interaction.reply({
        content: `❌ You already have an open prediction on **${displayTag(riotTag)}**.`,
        ephemeral: true,
      });
    }

    try {
      deductCoins(guildId, userId, amount);
      createPredict10(guildId, userId, puuid, wins, amount);
    } catch (err) {
      logger.error({ err: err.message }, 'predict10 confirm: place failed');
      return interaction.reply({ content: '❌ Failed to place prediction.', ephemeral: true });
    }
    state.delete(key);

    const x5 = amount * 5, x2 = amount * 2, x05 = Math.floor(amount * 0.5);

    // Replace the ephemeral selector with a success message.
    await interaction.update({
      content: `✅ Prediction placed on **${displayTag(riotTag)}** — **${wins}/10** for **${amount.toLocaleString()}** 🪙.`,
      components: [],
    });

    // Public announcement in the channel.
    await interaction.followUp({
      content:
        `🎯 <@${userId}> predicts **${displayTag(riotTag)}** wins **${wins}/10** for **${amount.toLocaleString()}** 🪙.\n` +
        `Payouts on settle: exact **${x5.toLocaleString()}** 🪙 (5×) · off-1 **${x2.toLocaleString()}** 🪙 (2×) · off-2 refund · off-3 **${x05.toLocaleString()}** 🪙 (half) · off-4+ **0** 🪙`,
      allowedMentions: { parse: [] },
    });
    return true;
  }

  return false;
}
