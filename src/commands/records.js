import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getPeakRecords, getPeakRecordSeasons, isEmojiEnabled } from '../db.js';
import config from '../../config.js';
import { displayTag } from '../utils/displayName.js';

const TIER_ORDER = [
  'CHALLENGER', 'GRANDMASTER', 'MASTER',
  'DIAMOND', 'EMERALD', 'PLATINUM', 'GOLD',
  'SILVER', 'BRONZE', 'IRON',
];
const RANK_ORDER = ['I', 'II', 'III', 'IV'];

function tierValue(tier, rank, lp) {
  const t = TIER_ORDER.indexOf(tier);
  const r = RANK_ORDER.indexOf(rank);
  return (TIER_ORDER.length - t) * 10000 + (RANK_ORDER.length - r) * 100 + lp;
}

export const data = new SlashCommandBuilder()
  .setName('records')
  .setDescription('Show historical peak Solo/Duo ranks from past seasons')
  .addStringOption(opt =>
    opt.setName('season')
      .setDescription('Which season to show (defaults to most recent)')
      .setAutocomplete(true)
      .setRequired(false)
  );

export async function autocomplete(interaction) {
  const seasons = getPeakRecordSeasons(interaction.guildId);
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = seasons
    .filter(s => s.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(s => ({ name: s, value: s }));
  await interaction.respond(matches);
}

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const requested = interaction.options.getString('season');

  const seasons = getPeakRecordSeasons(guildId);
  if (!seasons.length) {
    return interaction.reply({ content: 'No records yet.', ephemeral: true });
  }

  const season = requested || seasons[0];
  const rows = getPeakRecords(guildId, season);

  if (!rows.length) {
    return interaction.reply({ content: `No records found for season **${season}**.`, ephemeral: true });
  }

  const results = rows.map(p => ({
    tag: displayTag(p.riot_tag),
    tier: p.peak_tier,
    rank: `${p.peak_tier} ${p.peak_rank}`,
    lp: p.peak_lp,
    value: tierValue(p.peak_tier, p.peak_rank, p.peak_lp),
  }));

  results.sort((a, b) => b.value - a.value);

  const emojiOn = isEmojiEnabled(guildId);
  const lines = results.map((r, i) => {
    const pos = `${i + 1}.`;
    const emoji = emojiOn ? config.getRankEmoji(r.tier) : '';
    const prefix = emoji ? `${emoji} ` : '';
    return `${pos} ${prefix}**${r.tag}** — ${r.rank} (${r.lp} LP)`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Peak Solo/Duo Ranks — ${season}`)
    .setDescription(lines.join('\n'))
    .setColor(0xe67e22);

  return interaction.reply({ embeds: [embed] });
}
