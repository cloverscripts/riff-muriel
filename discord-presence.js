const { ipcMain, app } = require('electron');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_FRAME_BYTES = 1024 * 1024;
const CLIENT_ID = '1564605359610400929'; // Muriel's own Discord application
let socket = null;
let buffer = Buffer.alloc(0);
let activity = null;
let ready = false;
let connecting = false;
let retryTimer = null;

function ipcPaths() {
  const paths = [];
  for (let i = 0; i < 10; i++) {
    if (process.platform === 'win32') paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    else if (process.platform === 'darwin') paths.push(path.join(os.homedir(), 'Library', 'Application Support', `discord-ipc-${i}`));
    else {
      if (process.env.XDG_RUNTIME_DIR) paths.push(path.join(process.env.XDG_RUNTIME_DIR, `discord-ipc-${i}`));
      paths.push(`/run/user/${typeof process.getuid === 'function' ? process.getuid() : ''}/discord-ipc-${i}`);
      paths.push(`/tmp/discord-ipc-${i}`);
    }
  }
  return [...new Set(paths)];
}

function frame(opcode, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function sendActivity() {
  if (!ready || !socket || !activity) return;
  socket.write(frame(1, {
    cmd: 'SET_ACTIVITY',
    args: { pid: process.pid, activity },
    nonce: crypto.randomUUID(),
  }));
}

function scheduleRetry() {
  if (!activity || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectCandidate(0);
  }, 2500);
  if (retryTimer.unref) retryTimer.unref();
}

function connectCandidate(index) {
  if (!CLIENT_ID || !activity || socket || connecting) return;
  const candidates = ipcPaths();
  if (index >= candidates.length) {
    scheduleRetry();
    return;
  }

  connecting = true;
  buffer = Buffer.alloc(0);
  const current = net.createConnection(candidates[index]);
  socket = current;
  let failed = false;
  const tryNext = () => {
    if (failed) return;
    failed = true;
    if (socket === current) socket = null;
    connecting = false;
    ready = false;
    if (index + 1 < candidates.length) connectCandidate(index + 1);
    else scheduleRetry();
  };

  current.setTimeout(5000);
  current.once('connect', () => {
    current.write(frame(0, { v: 1, client_id: CLIENT_ID }));
  });
  current.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const opcode = buffer.readUInt32LE(0);
      const length = buffer.readUInt32LE(4);
      if (length > MAX_FRAME_BYTES) { current.destroy(); return; }
      if (buffer.length < 8 + length) break;
      const payload = buffer.subarray(8, 8 + length).toString('utf8');
      buffer = buffer.subarray(8 + length);
      if (opcode !== 1) continue;
      try {
        const message = JSON.parse(payload);
        if (message.evt === 'READY') {
          // presence was cleared while this socket was still connecting: it isn't ours any more, and marking
          // it ready would make every later update skip reconnecting
          if (socket !== current) { current.destroy(); return; }
          failed = true;
          connecting = false;
          ready = true;
          current.setTimeout(0);
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          sendActivity();
        }
      } catch (_) {}
    }
  });
  current.once('error', tryNext);
  // a socket that accepts but never answers moves on to the next one (destroy alone only fires 'close', which
  // started over at the first socket, so a Discord on discord-ipc-1 behind a stuck ipc-0 was never reached)
  current.once('timeout', () => { tryNext(); current.destroy(); });
  current.once('close', () => {
    if (socket !== current) return;
    socket = null;
    connecting = false;
    ready = false;
    if (activity) scheduleRetry();
  });
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128);
}

function setPresence(rawTrack) {
  const details = cleanText(rawTrack && rawTrack.title) || 'Unknown Track';
  const state = cleanText(rawTrack && rawTrack.artist) || 'Unknown Artist';
  if (!details && !state) return { ok: false, error: 'Presence text is empty.' };

  const nextActivity = {
    type: 2,
    details,
    state,
    instance: false
  };
  const duration = Number(rawTrack && rawTrack.duration);
  if (rawTrack && rawTrack.isPlaying) {
    const position = Math.max(0, Number(rawTrack.position) || 0);
    const start = Math.floor(Date.now() / 1000) - Math.floor(position);
    nextActivity.timestamps = { start };
    if (duration > 0) nextActivity.timestamps.end = start + Math.floor(duration);
  }
  const image = rawTrack && typeof rawTrack.thumbnail === 'string' ? rawTrack.thumbnail : '';
  if (/^https?:\/\//i.test(image) && !image.includes('127.0.0.1')) {
    nextActivity.assets = { large_image: image };
  }
  const url = rawTrack && typeof rawTrack.url === 'string' ? rawTrack.url : '';
  if (url.startsWith('https://') && url.length <= 512) nextActivity.buttons = [{ label: 'Listen', url }];
  activity = nextActivity;
  if (ready) sendActivity();
  else connectCandidate(0);
  return true;
}

function clearPresence() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const current = socket;
  if (current && ready) {
    current.write(frame(1, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: {} },
      nonce: crypto.randomUUID(),
    }));
  }
  activity = null;
  socket = null;
  ready = false;
  connecting = false;
  if (current && !current.destroyed) current.end();
}

function register(getWindow) {
  const isAppWindow = (event) => {
    const win = getWindow();
    return !!(win && !win.isDestroyed() && event.sender === win.webContents);
  };
  ipcMain.on('discord-presence-update', (event, track) => {
    if (isAppWindow(event)) setPresence(track);
  });
  ipcMain.on('discord-presence-clear', (event) => {
    if (isAppWindow(event)) clearPresence();
  });
  app.once('before-quit', clearPresence);
}

module.exports = { register };
