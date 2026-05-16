import logger from './utils/logger.js';
import { fileLog } from './utils/fileLog.js';
import { getGuildChannel, getActiveMatchMessageIds, clearLastMatchOverMessageByIds } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * DAY_MS;

// Delete the bot's own messages newer than `days` (default 3) from each guild's
// configured bet channel. Uses bulkDelete (max 100 at a time, only messages
// younger than 14 days). Falls back to individual deletes if bulkDelete fails.
export async function cleanupRecentBotMessages(client, days = 3) {
  if (!client?.user) {
    fileLog.warn('cleanup: no client or client.user, aborting');
    return { totalDeleted: 0, perGuild: [] };
  }

  const cutoff = Date.now() - days * DAY_MS;
  const botId = client.user.id;
  const perGuild = [];
  let totalDeleted = 0;

  for (const guild of client.guilds.cache.values()) {
    const result = await cleanupGuild(guild, botId, cutoff);
    perGuild.push(result);
    totalDeleted += result.deleted;
  }

  fileLog.info('cleanup: run finished', { days, totalDeleted, guilds: perGuild.length });
  return { totalDeleted, perGuild };
}

async function cleanupGuild(guild, botId, cutoff) {
  const channelId = getGuildChannel(guild.id);
  if (!channelId) return { guildId: guild.id, deleted: 0, reason: 'no channel configured' };

  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased?.()) {
    return { guildId: guild.id, deleted: 0, reason: 'channel missing or not text-based' };
  }

  // Protect messages tied to in-progress matches (active betting windows or
  // mid-match) — deleting these would strip live bet buttons.
  const protectedIds = getActiveMatchMessageIds(guild.id);

  let deleted = 0;
  const deletedIds = [];
  let lastId = undefined;
  // Cap pagination so a runaway loop can't burn through the channel
  let pages = 30;

  while (pages-- > 0) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;

    let batch;
    try {
      batch = await channel.messages.fetch(opts);
    } catch (err) {
      fileLog.error('cleanup: messages.fetch failed', { guildId: guild.id, channelId, err: err.message });
      break;
    }
    if (batch.size === 0) break;
    lastId = batch.last().id;

    const toDelete = batch.filter(m =>
      m.author.id === botId &&
      m.createdTimestamp >= cutoff &&
      Date.now() - m.createdTimestamp < FOURTEEN_DAYS_MS &&
      !protectedIds.has(m.id)
    );

    if (toDelete.size > 0) {
      try {
        const result = await channel.bulkDelete(toDelete, true);
        deleted += result.size;
        for (const id of result.keys()) deletedIds.push(id);
      } catch (err) {
        fileLog.warn('cleanup: bulkDelete failed, falling back', { guildId: guild.id, err: err.message });
        for (const msg of toDelete.values()) {
          try {
            await msg.delete();
            deleted++;
            deletedIds.push(msg.id);
            await new Promise(r => setTimeout(r, 500));
          } catch (e) {
            fileLog.warn('cleanup: individual delete failed', { messageId: msg.id, err: e.message });
          }
        }
      }
    }

    // Stop once we've paged past the cutoff window
    if (batch.last().createdTimestamp < cutoff) break;
    if (batch.size < 100) break;
  }

  // Clear any tracked_players.last_match_over_message_id pointing at messages
  // we just deleted, so the next-match cleanup hook doesn't chase ghosts.
  if (deletedIds.length) {
    const cleared = clearLastMatchOverMessageByIds(guild.id, deletedIds);
    if (cleared.changes > 0) {
      fileLog.info('cleanup: cleared stale last_match_over_message_id refs', { guildId: guild.id, cleared: cleared.changes });
    }
  }

  fileLog.info('cleanup: guild done', { guildId: guild.id, channelId, deleted });
  return { guildId: guild.id, deleted };
}

// Schedule cleanup for the next 12:01 AM local time, then re-schedule itself
// each night. If the bot is offline at the scheduled time, it simply won't
// run — the next launch will queue the next 12:01 AM.
let cleanupTimer = null;

export function startCleanupSchedule(client) {
  function scheduleNext() {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    const delay = msUntilNextRun(0, 1);
    const fireAt = new Date(Date.now() + delay);
    logger.info({ fireAt: fireAt.toISOString(), delayMin: Math.round(delay / 60000) }, 'cleanup: scheduled');
    cleanupTimer = setTimeout(async () => {
      try {
        const summary = await cleanupRecentBotMessages(client, 3);
        logger.info({ totalDeleted: summary.totalDeleted }, 'cleanup: nightly run complete');
      } catch (err) {
        logger.error({ err }, 'cleanup: nightly run failed');
        fileLog.error('cleanup: nightly run threw', { err: err.message });
      } finally {
        scheduleNext();
      }
    }, delay);
  }
  scheduleNext();
}

export function stopCleanupSchedule() {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
}

function msUntilNextRun(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
