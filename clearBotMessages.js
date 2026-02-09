import { REST, Routes } from 'discord.js';
import 'dotenv/config';

const CHANNEL_ID = process.argv[2];
const LIMIT = parseInt(process.argv[3] || '100', 10);

if (!CHANNEL_ID) {
  console.error('Usage: node clearBotMessages.js <channel_id> [limit]');
  console.error('  channel_id: The Discord channel ID to clear messages from');
  console.error('  limit: Max messages to scan (default: 100, max: 1000)');
  process.exit(1);
}

if (!process.env.DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN not found in .env file');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function run() {
  try {
    // Get bot user info
    const me = await rest.get(Routes.user());
    console.log(`Using bot: ${me.username}#${me.discriminator}`);
    console.log(`Bot ID: ${me.id}`);
    console.log(`Scanning channel: ${CHANNEL_ID}`);
    console.log(`Scanning up to ${LIMIT} messages...\n`);

    let deletedCount = 0;
    let scannedCount = 0;
    let lastId = null;
    const scanLimit = Math.min(LIMIT, 1000);

    while (scannedCount < scanLimit) {
      const fetchLimit = Math.min(100, scanLimit - scannedCount);
      let url = `${Routes.channelMessages(CHANNEL_ID)}?limit=${fetchLimit}`;
      if (lastId) url += `&before=${lastId}`;

      const messages = await rest.get(url);
      if (!messages.length) break;

      for (const message of messages) {
        scannedCount++;
        lastId = message.id;

        if (message.author.id === me.id) {
          try {
            await rest.delete(Routes.channelMessage(CHANNEL_ID, message.id));
            deletedCount++;
            const preview = message.content?.slice(0, 50) || message.embeds?.[0]?.title || '(embed)';
            console.log(`Deleted ${deletedCount}: ${preview}...`);
            await new Promise((r) => setTimeout(r, 500));
          } catch (err) {
            console.error(`Failed to delete ${message.id}: ${err.message}`);
          }
        }
      }
    }

    console.log(`\nDone! Deleted ${deletedCount} bot messages (scanned ${scannedCount} total)`);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
