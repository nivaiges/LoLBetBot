import 'dotenv/config';
import {
  Client, GatewayIntentBits, Collection, REST, Routes,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import logger from './utils/logger.js';
import { isRateLimited } from './utils/ratelimit.js';
import { startPoller } from './poller.js';
import {
  ensureUser,
  getActiveMatchByMatchId,
  getUserBetOnMatch,
  deductCoins,
  placeBet,
  getMatchParley,
  getUserParleyBetOnMatch,
  placeParleyBet,
  getAllTrackedPlayers,
  updateTrackedPlayerPuuid,
} from './db.js';
import config from '../config.js';
import { getAccountByRiotId } from './riot.js';
import { isBettingOpen } from './utils/bettingwindow.js';

// Import commands
import * as collect from './commands/collect.js';
import * as adduser from './commands/adduser.js';
import * as bet from './commands/bet.js';
import * as baltop from './commands/baltop.js';
import * as stats from './commands/stats.js';
import * as rank from './commands/rank.js';
import * as bethere from './commands/bethere.js';
import * as peak from './commands/peak.js';
import * as autobet from './commands/autobet.js';
import * as removeuser from './commands/removeuser.js';
import * as give from './commands/give.js';
import * as emoji from './commands/emoji.js';
import * as history from './commands/history.js';
import * as achievements from './commands/achievements.js';
import * as help from './commands/help.js';

// ── Validate env ─────────────────────────────────────────────────────────────

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

if (!DISCORD_TOKEN) {
  logger.fatal('Missing DISCORD_TOKEN environment variable');
  process.exit(1);
}
if (!RIOT_API_KEY) {
  logger.fatal('Missing RIOT_API_KEY environment variable');
  process.exit(1);
}

// ── Build command collection ─────────────────────────────────────────────────

const commands = [collect, adduser, removeuser, bet, baltop, stats, rank, bethere, peak, autobet, give, emoji, history, achievements, help];
const commandCollection = new Collection();
for (const cmd of commands) {
  commandCollection.set(cmd.data.name, cmd);
}

// ── Register slash commands per guild (instant updates) ─────────────────────

async function registerCommands(clientId) {
  const rest = new REST().setToken(DISCORD_TOKEN);
  const body = commands.map(c => c.data.toJSON());

  // Clear stale global commands
  await rest.put(Routes.applicationCommands(clientId), { body: [] }).catch(() => {});

  // Register per-guild for instant propagation
  for (const guild of client.guilds.cache.values()) {
    logger.info({ guildId: guild.id, count: body.length }, 'Registering guild commands');
    await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body });
  }
  logger.info('Slash commands registered');
}

// ── Create client ────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

async function refreshPuuids() {
  const players = getAllTrackedPlayers();
  logger.info({ count: players.length }, 'Refreshing tracked player PUUIDs for new API key');
  for (const player of players) {
    const parts = player.riot_tag.split('#');
    if (parts.length !== 2) continue;
    const account = await getAccountByRiotId(parts[0], parts[1], player.region);
    if (!account || account.rateLimited) {
      logger.warn({ riotTag: player.riot_tag }, 'Could not refresh PUUID');
      continue;
    }
    if (account.puuid !== player.puuid) {
      updateTrackedPlayerPuuid(player.id, account.puuid);
      logger.info({ riotTag: player.riot_tag }, 'Updated PUUID');
    }
  }
}

client.once('ready', async () => {
  logger.info({ user: client.user.tag, guilds: client.guilds.cache.size }, 'Bot is online');
  await registerCommands(client.user.id);
  await refreshPuuids();
  startPoller(client);
});

client.on('interactionCreate', async (interaction) => {
  // ── Slash commands ───────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const cmd = commandCollection.get(interaction.commandName);
    if (!cmd) return;

    if (isRateLimited(interaction.user.id)) {
      return interaction.reply({ content: '⏳ Slow down! Try again in a few seconds.', ephemeral: true });
    }

    try {
      await cmd.execute(interaction);
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, 'Command execution error');
      const reply = { content: '❌ Something went wrong executing that command.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
    return;
  }

  // ── Button clicks (bet_win / bet_lose / parley_over / parley_under) ─────
  if (interaction.isButton()) {
    const id = interaction.customId;

    // Win/Lose bet buttons
    if (id.startsWith('bet_win_') || id.startsWith('bet_lose_')) {
      const prediction = id.startsWith('bet_win_') ? 'win' : 'lose';
      const matchId = id.startsWith('bet_win_') ? id.slice('bet_win_'.length) : id.slice('bet_lose_'.length);

      if (!isBettingOpen(matchId)) {
        return interaction.reply({ content: '🔒 Betting is closed for this match.', ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`betmodal_${prediction}_${matchId}`)
        .setTitle(`Bet ${prediction.toUpperCase()} — Enter Amount`);

      const amountInput = new TextInputBuilder()
        .setCustomId('bet_amount')
        .setLabel('How many coins do you want to bet?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 5000')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
      await interaction.showModal(modal);
      return;
    }

    // Parley over/under buttons
    if (id.startsWith('parley_over_') || id.startsWith('parley_under_')) {
      const prediction = id.startsWith('parley_over_') ? 'over' : 'under';
      const matchId = id.startsWith('parley_over_') ? id.slice('parley_over_'.length) : id.slice('parley_under_'.length);

      if (!isBettingOpen(matchId)) {
        return interaction.reply({ content: '🔒 Betting is closed for this match.', ephemeral: true });
      }

      const parley = getMatchParley(interaction.guildId, matchId);
      if (!parley?.parley_stat) {
        return interaction.reply({ content: '❌ No parley available for this match.', ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`parleymodal_${prediction}_${matchId}`)
        .setTitle(`Parley ${prediction.toUpperCase()} — Enter Amount`);

      const amountInput = new TextInputBuilder()
        .setCustomId('bet_amount')
        .setLabel('How many coins do you want to bet?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 5000')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
      await interaction.showModal(modal);
      return;
    }

    return;
  }

  // ── Modal submit (bet amount / parley amount) ──────────────────────────
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;

    // Win/Lose bet modal
    if (id.startsWith('betmodal_')) {
      const prediction = id.split('_')[1];
      const matchId = id.slice(`betmodal_${prediction}_`.length);

      const amountStr = interaction.fields.getTextInputValue('bet_amount');
      const amount = parseInt(amountStr, 10);

      if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: '❌ Enter a valid positive number.', ephemeral: true });
      }

      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      if (!isBettingOpen(matchId)) {
        return interaction.reply({ content: '🔒 Betting closed while you were entering your amount.', ephemeral: true });
      }

      const match = getActiveMatchByMatchId(guildId, matchId);
      if (!match) {
        return interaction.reply({ content: '❌ This match is no longer active.', ephemeral: true });
      }

      const user = ensureUser(guildId, userId);

      if (user.coins < amount) {
        return interaction.reply({ content: `💰 Insufficient coins. You have **${user.coins.toLocaleString()}** 🪙.`, ephemeral: true });
      }

      const existing = getUserBetOnMatch(guildId, userId, matchId);
      if (existing) {
        return interaction.reply({ content: `⚠️ You already bet **${existing.prediction.toUpperCase()}** (${existing.amount.toLocaleString()} 🪙) on this match.`, ephemeral: true });
      }

      deductCoins(guildId, userId, amount);
      placeBet(guildId, userId, matchId, match.puuid, prediction, amount);

      const emoji = prediction === 'win' ? '🟢' : '🔴';
      return interaction.reply(
        `${emoji} **${interaction.user.username}** bet **${prediction.toUpperCase()}** for **${amount.toLocaleString()}** 🪙`
      );
    }

    // Parley modal
    if (id.startsWith('parleymodal_')) {
      const prediction = id.split('_')[1];
      const matchId = id.slice(`parleymodal_${prediction}_`.length);

      const amountStr = interaction.fields.getTextInputValue('bet_amount');
      const amount = parseInt(amountStr, 10);

      if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: '❌ Enter a valid positive number.', ephemeral: true });
      }

      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      if (!isBettingOpen(matchId)) {
        return interaction.reply({ content: '🔒 Betting closed while you were entering your amount.', ephemeral: true });
      }

      const match = getActiveMatchByMatchId(guildId, matchId);
      if (!match) {
        return interaction.reply({ content: '❌ This match is no longer active.', ephemeral: true });
      }

      const parley = getMatchParley(guildId, matchId);
      if (!parley?.parley_stat) {
        return interaction.reply({ content: '❌ No parley available for this match.', ephemeral: true });
      }

      const user = ensureUser(guildId, userId);

      if (user.coins < amount) {
        return interaction.reply({ content: `💰 Insufficient coins. You have **${user.coins.toLocaleString()}** 🪙.`, ephemeral: true });
      }

      const existing = getUserParleyBetOnMatch(guildId, userId, matchId);
      if (existing) {
        return interaction.reply({ content: `⚠️ You already placed a parley bet (**${existing.prediction.toUpperCase()}**, ${existing.amount.toLocaleString()} 🪙) on this match.`, ephemeral: true });
      }

      deductCoins(guildId, userId, amount);
      placeParleyBet(guildId, userId, matchId, prediction, amount);

      const isYesNo = parley.parley_stat === 'firstBlood' || parley.parley_stat === 'tripleKill';
      let betEmoji, displayPrediction;
      if (isYesNo) {
        betEmoji = prediction === 'over' ? '✅' : '❌';
        displayPrediction = prediction === 'over' ? 'YES' : 'NO';
      } else {
        betEmoji = prediction === 'over' ? '⬆️' : '⬇️';
        displayPrediction = prediction.toUpperCase();
      }
      return interaction.reply(
        `${betEmoji} **${interaction.user.username}** parley bet **${displayPrediction}** for **${amount.toLocaleString()}** 🪙`
      );
    }
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Login ────────────────────────────────────────────────────────────────────

client.login(DISCORD_TOKEN);
