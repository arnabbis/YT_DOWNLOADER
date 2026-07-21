const path = require('path');
const { spawn } = require('child_process');

function sanitizeFileName(name) {
  return String(name || 'download')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

function parseTimeToSeconds(value) {
  if (!value) return 0;
  const parts = String(value).split(':').map(Number).reverse();
  const [seconds = 0, minutes = 0, hours = 0] = parts;
  return hours * 3600 + minutes * 60 + seconds;
}

function isValidTime(value) {
  if (!value || value === '00:00:00') return true;
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return false;
  return Number(match[2]) < 60 && Number(match[3]) < 60;
}

function formatSeconds(value) {
  const total = Math.max(0, Number(value) || 0);
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function createCancelError(message = 'Command cancelled.') {
  const error = new Error(message);
  error.code = 'ERR_CANCELLED';
  return error;
}

function stopProcessTree(child) {
  if (!child || !child.pid || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, 1500).unref?.();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      onProcess,
      onOutput,
      signal,
      cancelMessage = 'Command cancelled.',
      ...spawnOptions
    } = options;
    if (signal?.aborted) {
      reject(createCancelError(cancelMessage));
      return;
    }
    const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let cancelled = false;

    const abortHandler = () => {
      cancelled = true;
      stopProcessTree(child);
    };

    signal?.addEventListener('abort', abortHandler, { once: true });
    onProcess?.(child);

    child.stdout.on('data', (chunk) => {
      const output = chunk.toString();
      stdout += output;
      onOutput?.('stdout', output);
    });
    child.stderr.on('data', (chunk) => {
      const output = chunk.toString();
      stderr += output;
      onOutput?.('stderr', output);
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', abortHandler);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abortHandler);
      if (cancelled || signal?.aborted) {
        reject(createCancelError(cancelMessage));
        return;
      }
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `Command failed with exit code ${code}`));
    });
  });
}

module.exports = {
  sanitizeFileName,
  parseTimeToSeconds,
  isValidTime,
  formatSeconds,
  runCommand,
};
