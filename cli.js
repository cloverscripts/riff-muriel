

const http = require('http');

const args = process.argv;
if (!args.includes('lyrics') && !args.includes('--lyrics')) {
  console.log('Usage: muriel lyrics');
  process.exit(0);
}

const PORT = 38472;
const URL = `http://127.0.0.1:${PORT}/api/lyrics-stream`;

let cfonts = null;
try {
  cfonts = require('cfonts');
} catch (e) {}

let lastStateKey = '';

function renderLatin(word, cols, rows) {
  const clean = word.toUpperCase();
  let renderedLines = [];

  if (cfonts) {
    try {
      let selectedFont = 'block';
      if (clean.length * 9 > cols) selectedFont = '3d';
      if (clean.length * 8 > cols) selectedFont = 'simpleBlock';
      if (clean.length * 5 > cols) selectedFont = 'console';

      const out = cfonts.render(clean, {
        font: selectedFont,
        align: 'center',
        colors: ['cyan', 'blue'],
        background: 'transparent',
        letterSpacing: 1,
        lineHeight: 1,
        space: false,
        maxLength: cols,
        env: 'node'
      });

      renderedLines = out.string.split('\n').filter(l => l.trim().length > 0);
    } catch (e) {
    }
  }

  if (renderedLines.length === 0) {
    const padX = Math.max(0, Math.floor((cols - clean.length) / 2));
    renderedLines = [' '.repeat(padX) + `\x1b[1;36m${clean}\x1b[0m`];
  }

  process.stdout.write('\x1b[2J\x1b[H');
  const padTop = Math.max(0, Math.floor((rows - renderedLines.length) / 2));
  process.stdout.write('\n'.repeat(padTop));
  renderedLines.forEach(line => process.stdout.write(line + '\n'));
}

function renderNonLatin(word, cols, rows) {
  const clean = word.toLowerCase();

  process.stdout.write('\x1b[2J\x1b[H');

  const padY = Math.max(0, Math.floor(rows / 2) - 1);
  const padX = Math.max(0, Math.floor((cols - clean.length) / 2));

  process.stdout.write('\n'.repeat(padY));
  process.stdout.write(' '.repeat(padX) + `\x1b[1;97m${clean}\x1b[0m\n`);
}

function renderWord(rawWord) {
  // control characters out first: lyrics come from outside providers, and an escape sequence would be run by the terminal
  const cleanWord = rawWord.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/[,.!?:;"'()[\]«»—–-、。「」]/g, '').trim();

  if (!cleanWord) return;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const isLatin = /^[\x00-\x7F]*$/.test(cleanWord);

  if (isLatin) {
    renderLatin(cleanWord, cols, rows);
  } else {
    renderNonLatin(cleanWord, cols, rows);
  }
}

function startStream() {
  process.stdout.write('\x1b[?25l');
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('\x1b[90m[Muriel CLI] Awaiting real-time lyrics stream...\x1b[0m');

  const req = http.get(URL, (res) => {
    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(part.substring(6).trim());
          if (!data.isPlaying) continue;

          const currentWord = (data.word || data.currentWord || '').trim();
          if (!currentWord) continue;

          const wIdx = data.wordIndex !== undefined ? data.wordIndex : -1;
          const lIdx = data.lineIndex !== undefined ? data.lineIndex : -1;
          const stateKey = `${lIdx}-${wIdx}-${currentWord}`;

          if (stateKey !== lastStateKey) {
            lastStateKey = stateKey;
            renderWord(currentWord);
          }
        } catch (e) {
        }
      }
    });

    res.on('close', () => setTimeout(startStream, 1500));
  });

  req.on('error', () => {
    setTimeout(startStream, 1500);
  });
}

process.on('SIGINT', () => {
  process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
  process.exit(0);
});
process.on('SIGTERM', () => {
  process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
  process.exit(0);
});

startStream();
