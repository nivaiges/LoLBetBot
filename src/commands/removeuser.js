import { SlashCommandBuilder } from 'discord.js';
import { getTrackedPlayers, removeTrackedPlayer } from '../db.js';
import { displayTag } from '../utils/displayName.js';

export const data = new SlashCommandBuilder()
  .setName('removeuser')
  .setDescription('Stop tracking a League of Legends player')
  .addStringOption(opt =>
    opt.setName('riot_id')
      .setDescription('Riot ID in GameName#TagLine format (e.g. Nivy#NA1)')
      .setAutocomplete(true)
      .setRequired(true)
  );

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

export async function execute(interaction) {
  const riotId = interaction.options.getString('riot_id');
  const guildId = interaction.guildId;

  const removed = removeTrackedPlayer(guildId, riotId);
  if (!removed) {
    return interaction.reply({ content: `❌ **${riotId}** is not being tracked in this server.`, ephemeral: true });
  }

  return interaction.reply(`✅ Stopped tracking **${riotId}**. Any auto-bets for this player have been removed.`);
}
