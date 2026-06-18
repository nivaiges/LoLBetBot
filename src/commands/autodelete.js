import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { isAutoDeleteEnabled, setAutoDeleteEnabled } from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('autodelete')
  .setDescription('Toggle auto-deletion of Match Detected / Match Over / BETTING CLOSED messages')
  .addStringOption(opt =>
    opt.setName('toggle')
      .setDescription('Turn auto-delete on or off')
      .setRequired(true)
      .addChoices(
        { name: 'on',  value: 'on' },
        { name: 'off', value: 'off' },
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  const toggle = interaction.options.getString('toggle');
  const enabled = toggle === 'on';
  setAutoDeleteEnabled(interaction.guildId, enabled);

  const current = isAutoDeleteEnabled(interaction.guildId);
  const status = current ? 'ON' : 'OFF';
  const blurb = current
    ? 'Previous Match Over messages will be deleted when a new match starts, and the Match Detected message will be replaced with a fresh BETTING CLOSED render at the end of the betting window.'
    : 'All bot messages will be preserved. When betting closes, the original Match Detected message stays in place and only the betting buttons are removed.';
  return interaction.reply(`Auto-delete is now **${status}** for this server.\n_${blurb}_`);
}
