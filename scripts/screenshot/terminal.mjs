export function observeTerminalDefaults(terminal, profile) {
  const applied = {}, events = [];
  const snapshot = () => ({ foreground: applied.foreground ?? profile.foreground, background: applied.background ?? profile.background });
  for (const [code, channel] of [[10, 'foreground'], [11, 'background']]) {
    terminal.term.parser.registerOscHandler(code, value => {
      if (value === '?') {
        const color = snapshot()[channel];
        events.push({ query: channel, value: color });
        terminal.send(`\x1b]${code};rgb:` + [1, 3, 5].map(i => color.slice(i, i + 2).repeat(2)).join('/') + '\x07');
      } else if (/^#[\da-f]{6}$/iu.test(value)) {
        applied[channel] = value.toLowerCase();
        events.push({ set: channel, value: applied[channel] });
      }
      return true;
    });
    terminal.term.parser.registerOscHandler(code + 100, () => {
      delete applied[channel]; events.push({ reset: channel }); return true;
    });
  }
  return { applied, events, snapshot };
}

export async function captureFrame(terminal) {
  for (;;) {
    const queue = terminal.queue;
    await queue;
    if (queue === terminal.queue) break;
  }
  const capture = terminal.captureScreen('preview', {});
  return { capture, ansi: Buffer.concat(terminal.raw) };
}
