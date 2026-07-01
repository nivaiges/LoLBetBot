import { SlashCommandBuilder } from 'discord.js';
import { addTrackedPlayer, getTrackedPlayerByTag } from '../db.js';
import { getAccountByRiotId, riotRateLimitMessage } from '../riot.js';
import config from '../../config.js';

// Only this Discord user can add tracked players. Keeps the watch-list
// curated to the people the bot owner actually wants the channel to follow.
const ADDUSER_ALLOWED_DISCORD_ID = '189916265060499456';

export const data = new SlashCommandBuilder()
  .setName('adduser')
  .setDescription('Track a League of Legends player for betting')
  .addStringOption(opt =>
    opt.setName('riot_id')
      .setDescription('Riot ID in GameName#TagLine format (e.g. Nivy#NA1)')
      .setRequired(true)
  );

export async function execute(interaction) {
  if (interaction.user.id !== ADDUSER_ALLOWED_DISCORD_ID) {
    return interaction.reply({
      content: '🔒 Only the bot owner can add tracked players. Ask them to run this for you.',
      ephemeral: true,
    });
  }

  const riotId = interaction.options.getString('riot_id');
  const parts = riotId.split('#');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return interaction.reply({ content: '❌ Invalid format. Use `GameName#TagLine` (e.g. `Nivy#NA1`).', ephemeral: true });
  }

  const [gameName, tagLine] = parts;
  const guildId = interaction.guildId;
  const region = config.riotRegion;

  // Check if already tracked
  const existing = getTrackedPlayerByTag(guildId, riotId);
  if (existing) {
    return interaction.reply({ content: `⚠️ **${riotId}** is already being tracked in this server.`, ephemeral: true });
  }

  await interaction.deferReply();

  const account = await getAccountByRiotId(gameName, tagLine, region);
  if (account?.rateLimited) {
    return interaction.editReply(riotRateLimitMessage());
  }
  if (!account) {
    return interaction.editReply(`Could not find Riot account **${riotId}**. Check the name and tagline.`);
  }

  addTrackedPlayer(guildId, riotId, account.puuid, region);
  return interaction.editReply(`✅ Now tracking **${riotId}** for match betting.`);
}
