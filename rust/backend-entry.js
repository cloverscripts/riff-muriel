// Sidecar entry: runs Muriel's backend (server.js) under plain Node for the Rust app and tells it, as one
// JSON line on stdout, where it listens. It exits when the app closes its stdin, so it never outlives it.
process.env.MURIEL_SHELL = 'rust';
const { startServer, PORT, getServerToken } = require('./server');
const platform = require('./platform');

startServer(PORT).then((port) => {
  process.stdout.write(JSON.stringify({
    ready: true,
    port,
    token: getServerToken(),
    dataDir: platform.DATA_DIR,
    defaultDataDir: platform.DEFAULT_DATA_DIR,
    libraryDir: platform.LIBRARY_DIR,
  }) + '\n');
}, (e) => {
  process.stdout.write(JSON.stringify({ ready: false, error: String(e && e.message || e) }) + '\n');
  process.exit(1);
});

process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
