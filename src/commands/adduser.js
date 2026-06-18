import { SlashCommandBuilder } from 'discord.js';
import { addTrackedPlayer, getTrackedPlayerByTag } from '../db.js';
import { getAccountByRiotId, riotRateLimitMessage } from '../riot.js';
import config from '../../config.js';

export const data = new SlashCommandBuilder()
  .setName('adduser')
  .setDescription('Track a League of Legends player for betting')
  .addStringOption(opt =>
    opt.setName('riot_id')
      .setDescription('Riot ID in GameName#TagLine format (e.g. Nivy#NA1)')
      .setRequired(true)
  );

export async function execute(interaction) {
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
