import { join, resolve } from 'path';
import { readdirSync, existsSync } from 'fs';
import { createReadStream } from 'fs';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport,
} from '@discordjs/voice';
import logger from './utils/logger.js';

const SOUNDS_DIR = resolve('sounds');
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.webm']);

/** Map<userId, string[]> of absolute file paths */
const sounds = new Map();

export function loadSounds() {
  sounds.clear();

  if (!existsSync(SOUNDS_DIR)) {
    logger.info('No sounds/ directory found — join sounds disabled');
    return;
  }

  const entries = readdirSync(SOUNDS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const userId = entry.name;
    const userDir = join(SOUNDS_DIR, userId);
    const files = readdirSync(userDir)
      .filter(f => AUDIO_EXTS.has(f.slice(f.lastIndexOf('.')).toLowerCase()))
      .map(f => join(userDir, f));

    if (files.length > 0) {
      sounds.set(userId, files);
    }
  }

  logger.info({ users: sounds.size, ids: [...sounds.keys()] }, 'Loaded join sounds');
  logger.info(generateDependencyReport(), 'Voice dependency report');
}

export async function playJoinSound(member) {
  logger.info({ userId: member.id, hasEntry: sounds.has(member.id) }, 'voiceStateUpdate triggered');

  const files = sounds.get(member.id);
  if (!files || files.length === 0) return;

  const voiceChannel = member.voice.channel;
  if (!voiceChannel) return;

  const file = files[Math.floor(Math.random() * files.length)];
  logger.info({ userId: member.id, file }, 'Attempting to play join sound');

  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    connection.on('stateChange', (oldS, newS) => {
      logger.info({ from: oldS.status, to: newS.status }, 'Voice connection state change');
    });

    connection.on('error', (err) => {
      logger.error({ err: err.message, stack: err.stack }, 'Voice connection error');
    });

    connection.on('debug', (msg) => {
      logger.debug({ msg }, 'Voice connection debug');
    });

    // Wait for the connection to be ready (15s timeout)
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const player = createAudioPlayer();
    const resource = createAudioResource(createReadStream(file));

    connection.subscribe(player);
    player.play(resource);

    // Wait for the player to finish, then linger 10s before leaving
    await entersState(player, AudioPlayerStatus.Idle, 30_000);
    await new Promise(r => setTimeout(r, 10_000));

    connection.destroy();
  } catch (err) {
    logger.warn({ err: err.message, userId: member.id, file }, 'playJoinSound failed');
    try { connection?.destroy(); } catch {}
  }
}
