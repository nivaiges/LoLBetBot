import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getRankedStatsByPuuid } from '../riot.js';
import { getTrackedPlayers } from '../db.js';
import config from '../../config.js';

const TIER_ORDER = [
  'CHALLENGER', 'GRANDMASTER', 'MASTER',
  'DIAMOND', 'EMERALD', 'PLATINUM', 'GOLD',
  'SILVER', 'BRONZE', 'IRON',
];
const RANK_ORDER = ['I', 'II', 'III', 'IV'];

function tierValue(tier, rank, lp) {
  const t = TIER_ORDER.indexOf(tier);
  const r = RANK_ORDER.indexOf(rank);
  // Lower index = higher rank. Invert so higher value = better.
  return (TIER_ORDER.length - t) * 10000 + (RANK_ORDER.length - r) * 100 + lp;
}

export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Show ranks of all tracked players');

export async function execute(interaction) {
  const guildId = interaction.guildId;
  const players = getTrackedPlayers(guildId);

  if (!players.length) {
    return interaction.reply({ content: 'No tracked players. Use `/adduser` to add some.', ephemeral: true });
  }

  await interaction.deferReply();

  const results = [];

  for (const player of players) {
    const entries = await getRankedStatsByPuuid(player.puuid, player.region);
    if (!entries || entries.rateLimited) {
      if (entries?.rateLimited) {
        results.push({ tag: player.riot_tag, rank: null, error: 'Rate limited' });
        break;
      }
      results.push({ tag: player.riot_tag, rank: null });
      continue;
    }

    const solo = Array.isArray(entries) && entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
    if (!solo) {
      results.push({ tag: player.riot_tag, rank: null });
    } else {
      const value = tierValue(solo.tier, solo.rank, solo.leaguePoints);
      results.push({
        tag: player.riot_tag,
        tier: solo.tier,
        rank: `${solo.tier} ${solo.rank}`,
        lp: solo.leaguePoints,
        record: `${solo.wins}W / ${solo.losses}L`,
        value,
      });
    }
  }

  // Sort ranked players first (by value desc), then unranked at bottom
  results.sort((a, b) => {
    if (a.value != null && b.value != null) return b.value - a.value;
    if (a.value != null) return -1;
    if (b.value != null) return 1;
    return 0;
  });

  const lines = results.map((r, i) => {
    const pos = `${i + 1}.`;
    if (r.rank) {
      const emoji = config.getRankEmoji(r.tier);
      const prefix = emoji ? `${emoji} ` : '';
      return `${pos} ${prefix}**${r.tag}** — ${r.rank} (${r.lp} LP) • ${r.record}`;
    }
    return `${pos} **${r.tag}** — Unranked`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Tracked Players — Solo/Duo Ranks')
    .setDescription(lines.join('\n'))
    .setColor(0x9b59b6);

  return interaction.editReply({ embeds: [embed] });
}
