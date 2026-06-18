import 'dotenv/config';
import {
  Client, GatewayIntentBits, Collection, REST, Routes,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import logger from './utils/logger.js';
import { fileLog } from './utils/fileLog.js';
import { isRateLimited } from './utils/ratelimit.js';
import { startPoller } from './poller.js';
import { displayTag } from './utils/displayName.js';
import {
  ensureUser,
  getActiveMatchByMatchId,
  getActiveMatchByMessageId,
  getUserBetOnMatch,
  deductCoins,
  placeBet,
  getMatchParlay,
  getUserParleyBetOnMatch,
  placeParleyBet,
  getAllTrackedPlayers,
  updateTrackedPlayerPuuid,
  updateCollect,
  setAutoBet,
} from './db.js';
import config from '../config.js';
import { getAccountByRiotId } from './riot.js';
import { isBettingOpen } from './utils/bettingwindow.js';
import { loadSounds, playJoinSound } from './joinSound.js';

// Import commands
import * as collect from './commands/collect.js';
import * as adduser from './commands/adduser.js';
import * as bet from './commands/bet.js';
import * as baltop from './commands/baltop.js';
import * as stats from './commands/stats.js';
import * as rank from './commands/rank.js';
import * as bethere from './commands/bethere.js';
import * as records from './commands/records.js';
import * as lp from './commands/lp.js';
import * as lpc from './commands/lpc.js';
import * as autobet from './commands/autobet.js';
import * as removeuser from './commands/removeuser.js';
import * as give from './commands/give.js';
import * as emoji from './commands/emoji.js';
import * as autodelete from './commands/autodelete.js';
import * as history from './commands/history.js';
import * as achievements from './commands/achievements.js';
import * as help from './commands/help.js';
import * as duo from './commands/duo.js';
import * as predict10 from './commands/predict10.js';
import * as predictions from './commands/predictions.js';

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

const commands = [collect, adduser, removeuser, bet, baltop, stats, rank, bethere, records, lp, lpc, autobet, give, emoji, autodelete, history, achievements, help, duo, predict10, predictions];
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
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

loadSounds();

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!oldState.channelId && newState.channelId) {
    playJoinSound(newState.member);
  }
});

client.once('ready', async () => {
  logger.info({ user: client.user.tag, guilds: client.guilds.cache.size }, 'Bot is online');
  await registerCommands(client.user.id);
  await refreshPuuids();
  startPoller(client);
});

client.on('interactionCreate', async (interaction) => {
  // ── Autocomplete ─────────────────────────────────────────────────────────
  if (interaction.isAutocomplete()) {
    const cmd = commandCollection.get(interaction.commandName);
    if (cmd?.autocomplete) {
      try {
        await cmd.autocomplete(interaction);
      } catch (err) {
        logger.error({ err, command: interaction.commandName }, 'Autocomplete error');
      }
    }
    return;
  }

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

  // ── /predict10 component flow (string selects + confirm button) ──────────
  if (interaction.isStringSelectMenu() || (interaction.isButton() && interaction.customId.startsWith('predict10_'))) {
    if (await predict10.handleComponent(interaction)) return;
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

    // Keep in Chat button — re-posts the graph as a standalone chat message
    // (untracked by last_match_over_message_id, so it survives the auto-clear
    // when the next match starts). Cleared by the nightly 12:01 AM cleanup.
    if (id.startsWith('keep_gold_')) {
      const matchId = id.slice('keep_gold_'.length);
      if (!config.saveGraphAllowedUserIds.has(interaction.user.id)) {
        return interaction.reply({ content: '❌ You\'re not allowed to do that.', ephemeral: true });
      }
      // Embeds with setImage('attachment://...') consume the attachment into
      // the embed image, so message.attachments is often empty. Try both.
      const url = interaction.message?.attachments?.first()?.url
                || interaction.message?.embeds?.[0]?.image?.url;
      if (!url) {
        return interaction.reply({ content: '❌ No graph found on this message.', ephemeral: true });
      }
      try {
        const res = await fetch(url);
        if (!res.ok) {
          return interaction.reply({ content: `❌ Failed to fetch graph (HTTP ${res.status}).`, ephemeral: true });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const channel = interaction.channel;
        if (!channel) {
          return interaction.reply({ content: '❌ Channel not available.', ephemeral: true });
        }
        await channel.send({
          content: `📌 Kept by **${interaction.user.username}** — match \`${matchId}\``,
          files: [{ attachment: buf, name: `gold-lead-${matchId}.png` }],
          allowedMentions: { parse: [] },
        });
        return interaction.reply({ content: '✅ Posted to chat.', ephemeral: true });
      } catch (err) {
        logger.error({ err: err.message, matchId, userId: interaction.user.id }, 'keep_gold failed');
        return interaction.reply({ content: `❌ Failed: ${err.message}`, ephemeral: true });
      }
    }

    // Auto-bet button — opens a modal to set an auto-bet on this player
    if (id.startsWith('autobet_')) {
      const matchId = id.slice('autobet_'.length);
      fileLog.info('autobet: button clicked', { matchId, userId: interaction.user.id, messageId: interaction.message?.id });

      const modal = new ModalBuilder()
        .setCustomId(`autobetmodal_${matchId}`)
        .setTitle('Set Auto-Bet — applies every game');

      const predInput = new TextInputBuilder()
        .setCustomId('autobet_prediction')
        .setLabel('win or lose?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('win or lose')
        .setRequired(true);

      const amountInput = new TextInputBuilder()
        .setCustomId('autobet_amount')
        .setLabel('How many coins per game?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 5000')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(predInput),
        new ActionRowBuilder().addComponents(amountInput),
      );
      await interaction.showModal(modal);
      return;
    }

    // Parlay button — opens a multi-leg prediction modal
    if (id.startsWith('parlay_place_')) {
      const matchId = id.slice('parlay_place_'.length);

      if (!isBettingOpen(matchId)) {
        return interaction.reply({ content: '🔒 Betting is closed for this match.', ephemeral: true });
      }

      // Parlay is a side-bet — you have to take a position on the match
      // (WIN or LOSE) before you can stack legs on top of it. This prevents
      // people from cherry-picking parlays without committing to the match.
      if (!getUserBetOnMatch(interaction.guildId, interaction.user.id, matchId)) {
        return interaction.reply({
          content: '🎰 Place a 🟢 **WIN** or 🔴 **LOSE** bet on this match first — parlay is a side-bet, not a substitute.',
          ephemeral: true,
        });
      }

      const parlayLegs = getMatchParlay(interaction.guildId, matchId);
      if (!parlayLegs || parlayLegs.length === 0) {
        return interaction.reply({ content: '❌ No parlay available for this match.', ephemeral: true });
      }

      const multiplier = Math.pow(2, parlayLegs.length);
      const modal = new ModalBuilder()
        .setCustomId(`parlaymodal_${matchId}`)
        .setTitle(`${parlayLegs.length}-Leg Parlay — ${multiplier}x if ALL hit`);

      const amountInput = new TextInputBuilder()
        .setCustomId('parlay_amount')
        .setLabel('Amount to bet')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 5000')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(amountInput));

      for (let i = 0; i < parlayLegs.length; i++) {
        const leg = parlayLegs[i];
        const isYesNo = leg.type === 'yesno';
        const label = isYesNo
          ? `Leg ${i + 1}: ${leg.label} (yes / no)`
          : `Leg ${i + 1}: ${leg.label} ${leg.line} (over / under)`;
        const input = new TextInputBuilder()
          .setCustomId(`parlay_leg_${i}`)
          .setLabel(label.slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(isYesNo ? 'yes or no' : 'over or under')
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      }

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

      let autoCollected = false;
      if (user.coins < amount) {
        const collected = tryAutoCollect(guildId, userId, user);
        if (collected !== null) {
          user.coins = collected;
          autoCollected = true;
        }
        if (user.coins < amount) {
          return interaction.reply({ content: `💰 Insufficient coins. You have **${user.coins.toLocaleString()}** 🪙.`, ephemeral: true });
        }
      }

      const existing = getUserBetOnMatch(guildId, userId, matchId);
      if (existing) {
        return interaction.reply({ content: `⚠️ You already bet **${existing.prediction.toUpperCase()}** (${existing.amount.toLocaleString()} 🪙) on this match.`, ephemeral: true });
      }

      deductCoins(guildId, userId, amount);
      placeBet(guildId, userId, matchId, match.puuid, prediction, amount);

      const emoji = prediction === 'win' ? '🟢' : '🔴';
      const collectNote = autoCollected ? `\n🪙 Auto-collected **${config.collectAmount.toLocaleString()}** coins!` : '';
      return interaction.reply(
        `${emoji} **${interaction.user.username}** bet **${prediction.toUpperCase()}** for **${amount.toLocaleString()}** 🪙${collectNote}`
      );
    }

    // Auto-bet modal — save user's auto-bet for the player from this message
    if (id.startsWith('autobetmodal_')) {
      const matchId = id.slice('autobetmodal_'.length);

      const predRaw = interaction.fields.getTextInputValue('autobet_prediction').trim().toLowerCase();
      const amountStr = interaction.fields.getTextInputValue('autobet_amount');
      const messageId = interaction.message?.id;
      fileLog.info('autobet: modal submitted', { matchId, userId: interaction.user.id, messageId, predRaw, amountStr });

      if (predRaw !== 'win' && predRaw !== 'lose') {
        fileLog.warn('autobet: invalid prediction, rejecting', { predRaw });
        return interaction.reply({ content: '❌ Type **win** or **lose**.', ephemeral: true });
      }
      const amount = parseInt(amountStr, 10);
      if (isNaN(amount) || amount <= 0) {
        fileLog.warn('autobet: invalid amount, rejecting', { amountStr });
        return interaction.reply({ content: '❌ Enter a valid positive number.', ephemeral: true });
      }

      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      // Resolve which tracked player this message refers to (handles duo: each
      // tracked player in the same match has its own message_id).
      const rowByMsg = messageId ? getActiveMatchByMessageId(guildId, messageId) : null;
      const rowByMatch = !rowByMsg ? getActiveMatchByMatchId(guildId, matchId) : null;
      const row = rowByMsg || rowByMatch;
      fileLog.info('autobet: active_match lookup', { matchId, messageId, lookupBy: rowByMsg ? 'message_id' : (rowByMatch ? 'match_id' : 'none'), foundPuuid: row?.puuid ?? null });

      if (!row) {
        fileLog.warn('autobet: no active match row found, aborting', { matchId, messageId });
        return interaction.reply({ content: '❌ This match is no longer active.', ephemeral: true });
      }

      const player = getAllTrackedPlayers().find(p => p.guild_id === guildId && p.puuid === row.puuid);
      const playerLabel = player ? `**${displayTag(player.riot_tag)}**` : 'this player';

      const user = ensureUser(guildId, userId);
      const writeResult = setAutoBet(guildId, userId, row.puuid, predRaw, amount);
      fileLog.info('autobet: setAutoBet executed', { guildId, userId, puuid: row.puuid, riotTag: player?.riot_tag, predRaw, amount, changes: writeResult.changes, lastInsertRowid: writeResult.lastInsertRowid });

      const emoji = predRaw === 'win' ? '🟢' : '🔴';
      const autobetLine = `🟡 Auto-bet set: ${emoji} **${predRaw.toUpperCase()}** for **${amount.toLocaleString()}** 🪙 every game on ${playerLabel}.`;

      // Also try to place a bet on the current match
      let currentBetPlaced = false;
      let currentBetSkipReason = null;
      let autoCollected = false;

      if (!isBettingOpen(matchId)) {
        currentBetSkipReason = '🔒 Betting closed for this match — autobet will fire next game.';
      } else if (getUserBetOnMatch(guildId, userId, matchId)) {
        currentBetSkipReason = '⚠️ You already have a bet on this match — autobet saved for future games.';
      } else {
        if (user.coins < amount) {
          const collected = tryAutoCollect(guildId, userId, user);
          if (collected !== null) {
            user.coins = collected;
            autoCollected = true;
          }
        }
        if (user.coins < amount) {
          currentBetSkipReason = `💰 Not enough coins to bet on this match (have **${user.coins.toLocaleString()}** 🪙) — autobet saved for future games.`;
        } else {
          deductCoins(guildId, userId, amount);
          placeBet(guildId, userId, matchId, row.puuid, predRaw, amount);
          currentBetPlaced = true;
          fileLog.info('autobet: also placed bet on current match', { matchId, userId, puuid: row.puuid, predRaw, amount });
        }
      }

      if (currentBetPlaced) {
        const collectNote = autoCollected ? `\n🪙 Auto-collected **${config.collectAmount.toLocaleString()}** coins!` : '';
        return interaction.reply({
          content: `${autobetLine}\n${emoji} **${interaction.user.username}** also bet **${predRaw.toUpperCase()}** on this match for **${amount.toLocaleString()}** 🪙${collectNote}`,
        });
      }

      return interaction.reply({
        content: `${autobetLine}\n${currentBetSkipReason}`,
        ephemeral: true,
      });
    }

    // Parlay modal — multi-leg, all must hit
    if (id.startsWith('parlaymodal_')) {
      const matchId = id.slice('parlaymodal_'.length);

      const amountStr = interaction.fields.getTextInputValue('parlay_amount');
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

      // Re-check the base-bet gate at submit time — covers the edge case
      // where someone opens the modal first, then deletes/swaps their bet.
      if (!getUserBetOnMatch(guildId, userId, matchId)) {
        return interaction.reply({
          content: '🎰 Place a 🟢 **WIN** or 🔴 **LOSE** bet on this match first — parlay is a side-bet, not a substitute.',
          ephemeral: true,
        });
      }

      const parlayLegs = getMatchParlay(guildId, matchId);
      if (!parlayLegs || parlayLegs.length === 0) {
        return interaction.reply({ content: '❌ No parlay available for this match.', ephemeral: true });
      }

      // Parse and validate each leg prediction
      const predictions = [];
      for (let i = 0; i < parlayLegs.length; i++) {
        const leg = parlayLegs[i];
        const raw = interaction.fields.getTextInputValue(`parlay_leg_${i}`).trim().toLowerCase();
        const isYesNo = leg.type === 'yesno';
        if (isYesNo) {
          if (raw === 'yes') predictions.push('over');
          else if (raw === 'no') predictions.push('under');
          else return interaction.reply({ content: `❌ Leg ${i + 1} (${leg.label}): type **yes** or **no**.`, ephemeral: true });
        } else {
          if (raw === 'over') predictions.push('over');
          else if (raw === 'under') predictions.push('under');
          else return interaction.reply({ content: `❌ Leg ${i + 1} (${leg.label}): type **over** or **under**.`, ephemeral: true });
        }
      }

      const user = ensureUser(guildId, userId);

      let autoCollected = false;
      if (user.coins < amount) {
        const collected = tryAutoCollect(guildId, userId, user);
        if (collected !== null) {
          user.coins = collected;
          autoCollected = true;
        }
        if (user.coins < amount) {
          return interaction.reply({ content: `💰 Insufficient coins. You have **${user.coins.toLocaleString()}** 🪙.`, ephemeral: true });
        }
      }

      const existing = getUserParleyBetOnMatch(guildId, userId, matchId);
      if (existing) {
        return interaction.reply({ content: '⚠️ You already placed a parlay bet on this match.', ephemeral: true });
      }

      deductCoins(guildId, userId, amount);
      placeParleyBet(guildId, userId, matchId, predictions, amount);

      const multiplier = Math.pow(2, parlayLegs.length);
      const legSummary = predictions.map((pred, i) => {
        const leg = parlayLegs[i];
        const isYesNo = leg.type === 'yesno';
        const display = isYesNo ? (pred === 'over' ? 'YES' : 'NO') : pred.toUpperCase();
        return `Leg ${i + 1} ${leg.label}: **${display}**`;
      }).join('\n');

      const collectNote = autoCollected ? `\n🪙 Auto-collected **${config.collectAmount.toLocaleString()}** coins!` : '';
      return interaction.reply(
        `🎰 **${interaction.user.username}** placed a **${parlayLegs.length}-leg parlay** for **${amount.toLocaleString()}** 🪙 (${multiplier}x if ALL hit!)\n${legSummary}${collectNote}`
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
