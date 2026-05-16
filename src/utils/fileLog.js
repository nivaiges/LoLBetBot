import { appendFileSync, mkdirSync } from 'fs';

mkdirSync('logs', { recursive: true });

const LOG_FILE = 'logs/cleanup.txt';

function write(level, message, data) {
  const ts = new Date().toISOString();
  const dataStr = data && Object.keys(data).length
    ? ' ' + JSON.stringify(data)
    : '';
  const line = `[${ts}] [${level}] ${message}${dataStr}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // If we can't write to the log file, there's nothing we can do
  }
}

export const fileLog = {
  info:  (msg, data) => write('INFO ', msg, data),
  warn:  (msg, data) => write('WARN ', msg, data),
  error: (msg, data) => write('ERROR', msg, data),
};
