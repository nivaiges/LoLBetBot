import { REST, Routes } from 'discord.js';
import 'dotenv/config';
import db from './src/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * DAY_MS;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daysArg = args.find(a => /^\d+$/.test(a));
const days = daysArg ? parseInt(daysArg, 10) : 3;

if (!process.env.DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN not found in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function run() {
  const me = await rest.get(Routes.user());
  const cutoff = Date.now() - days * DAY_MS;
  console.log(`Bot: ${me.username} (${me.id})`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no deletions)' : 'LIVE (will delete)'}`);
  console.log(`Window: messages younger than ${days} day(s) (after ${new Date(cutoff).toISOString()})`);

  const guildSettings = db.prepare('SELECT guild_id, channel_id FROM guild_settings WHERE channel_id != \'\' AND channel_id IS NOT NULL').all();
  if (!guildSettings.length) {
    console.log('No configured guild channels.');
    db.close();
    return;
  }

  let totalDeleted = 0;
  let totalCandidates = 0;

  for (const { guild_id, channel_id } of guildSettings) {
    console.log(`\n— Guild ${guild_id} → channel ${channel_id} —`);

    // Skip messages tied to any in-progress match so we don't strip live bet buttons.
    const activeRows = db.prepare(`
      SELECT message_id, close_message_id FROM active_matches
      WHERE guild_id = ? AND state = 'active'
    `).all(guild_id);
    const protectedIds = new Set();
    for (const r of activeRows) {
      if (r.message_id) protectedIds.add(r.message_id);
      if (r.close_message_id) protectedIds.add(r.close_message_id);
    }
    if (protectedIds.size) console.log(`  protecting ${protectedIds.size} active-match message(s)`);

    let deleted = 0;
    const deletedIds = [];
    let candidates = 0;
    let lastId = undefined;
    let pages = 30;

    while (pages-- > 0) {
      let url = `${Routes.channelMessages(channel_id)}?limit=100`;
      if (lastId) url += `&before=${lastId}`;
      let messages;
      try {
        messages = await rest.get(url);
      } catch (err) {
        console.error(`  fetch failed: ${err.message}`);
        break;
      }
      if (!messages.length) break;
      lastId = messages[messages.length - 1].id;

      const eligible = messages.filter(m => {
        const ts = Date.parse(m.timestamp);
        return m.author?.id === me.id
          && ts >= cutoff
          && Date.now() - ts < FOURTEEN_DAYS_MS
          && !protectedIds.has(m.id);
      });
      candidates += eligible.length;

      if (eligible.length > 0 && !dryRun) {
        if (eligible.length >= 2) {
          // Bulk delete
          try {
            await rest.post(Routes.channelBulkDelete(channel_id), {
              body: { messages: eligible.map(m => m.id) },
            });
            deleted += eligible.length;
            for (const m of eligible) deletedIds.push(m.id);
            console.log(`  bulk-deleted ${eligible.length}`);
          } catch (err) {
            console.warn(`  bulkDelete failed (${err.message}), falling back to single`);
            for (const m of eligible) {
              try {
                await rest.delete(Routes.channelMessage(channel_id, m.id));
                deleted++;
                deletedIds.push(m.id);
                await new Promise(r => setTimeout(r, 500));
              } catch (e) {
                console.warn(`    single delete ${m.id} failed: ${e.message}`);
              }
            }
          }
        } else {
          // Single delete
          for (const m of eligible) {
            try {
              await rest.delete(Routes.channelMessage(channel_id, m.id));
              deleted++;
              deletedIds.push(m.id);
              await new Promise(r => setTimeout(r, 500));
            } catch (e) {
              console.warn(`    single delete ${m.id} failed: ${e.message}`);
            }
          }
        }
      }

      const oldest = Date.parse(messages[messages.length - 1].timestamp);
      if (oldest < cutoff) break;
      if (messages.length < 100) break;
    }

    // Clear any tracked_players.last_match_over_message_id refs to deleted messages.
    if (!dryRun && deletedIds.length) {
      const placeholders = deletedIds.map(() => '?').join(',');
      const cleared = db.prepare(
        `UPDATE tracked_players SET last_match_over_message_id = NULL
         WHERE guild_id = ? AND last_match_over_message_id IN (${placeholders})`
      ).run(guild_id, ...deletedIds);
      if (cleared.changes > 0) console.log(`  cleared ${cleared.changes} stale match-over ref(s)`);
    }

    console.log(`  candidates: ${candidates}${dryRun ? '' : `, deleted: ${deleted}`}`);
    totalDeleted += deleted;
    totalCandidates += candidates;
  }

  console.log(`\nTotal candidates: ${totalCandidates}`);
  if (!dryRun) console.log(`Total deleted: ${totalDeleted}`);
  db.close();
}

run().catch(err => {
  console.error('Fatal:', err);
  db.close();
  process.exit(1);
});
