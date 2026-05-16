import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getPeakRanks, isEmojiEnabled } from '../db.js';
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
  .setName('peak')
  .setDescription('Show the peak Solo/Duo rank of all tracked players');

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const players = getPeakRanks(guildId);

  if (!players.length) {
    return interaction.reply({ content: 'No tracked players. Use `/adduser` to add some.', ephemeral: true });
  }

  const results = players.map(p => {
    if (!p.peak_tier) return { tag: displayTag(p.riot_tag), rank: null };
    return {
      tag: displayTag(p.riot_tag),
      tier: p.peak_tier,
      rank: `${p.peak_tier} ${p.peak_rank}`,
      lp: p.peak_lp,
      value: tierValue(p.peak_tier, p.peak_rank, p.peak_lp),
    };
  });

  results.sort((a, b) => {
    if (a.value != null && b.value != null) return b.value - a.value;
    if (a.value != null) return -1;
    if (b.value != null) return 1;
    return 0;
  });

  const emojiOn = isEmojiEnabled(guildId);
  const lines = results.map((r, i) => {
    const pos = `${i + 1}.`;
    if (r.rank) {
      const emoji = emojiOn ? config.getRankEmoji(r.tier) : '';
      const prefix = emoji ? `${emoji} ` : '';
      return `${pos} ${prefix}**${r.tag}** — ${r.rank} (${r.lp} LP)`;
    }
    return `${pos} **${r.tag}** — No peak recorded`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Tracked Players — Peak Solo/Duo Ranks')
    .setDescription(lines.join('\n'))
    .setColor(0xe67e22);

  return interaction.reply({ embeds: [embed] });
}
