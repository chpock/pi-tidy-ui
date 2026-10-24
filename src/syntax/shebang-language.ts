export const MAX_SHEBANG_BYTES = 1024;

const aliases: Readonly<Record<string, string>> = {
  awk: 'awk', gawk: 'awk', mawk: 'awk', nawk: 'awk',
  bash: 'bash', sh: 'bash', dash: 'bash', ash: 'bash', ksh: 'bash', zsh: 'bash',
  node: 'javascript', nodejs: 'javascript',
  coffee: 'coffeescript',
  clojure: 'clojure', bb: 'clojure',
  elixir: 'elixir', iex: 'elixir',
  erl: 'erlang', erlc: 'erlang', escript: 'erlang',
  groovy: 'groovy',
  ghci: 'haskell', runghc: 'haskell', runhaskell: 'haskell', runhugs: 'haskell',
  java: 'java', jshell: 'java',
  julia: 'julia',
  kotlin: 'kotlin', kotlinc: 'kotlin',
  lua: 'lua', luajit: 'lua',
  ocaml: 'ocaml', ocamlrun: 'ocaml',
  perl: 'perl',
  php: 'php',
  pwsh: 'powershell', powershell: 'powershell',
  python: 'python',
  racket: 'racket', raco: 'racket',
  Rscript: 'r',
  ruby: 'ruby', jruby: 'ruby', truffleruby: 'ruby', macruby: 'ruby', rake: 'ruby', rbx: 'ruby',
  scala: 'scala',
  swift: 'swift',
  tclsh: 'tcl', wish: 'tcl',
  'rust-script': 'rust',
  tsx: 'typescript', 'ts-node': 'typescript', 'ts-node-esm': 'typescript',
};

function executableToken(command: string): boolean {
  return /^[A-Za-z0-9._+/-]+$/u.test(command) && !/^[A-Za-z]:\//u.test(command);
}

function interpreterName(command: string): string | undefined {
  if (!executableToken(command)) return undefined;
  const name = command.split('/').at(-1);
  if (!name) return undefined;
  if (/^python[23](?:\.\d+)*$/u.test(name) || /^pypy[23]?(?:\.\d+)*$/u.test(name)) return 'python';
  if (/^node(?:js)?\d+(?:\.\d+)*$/u.test(name)) return 'javascript';
  if (/^ruby\d+(?:\.\d+)*$/u.test(name)) return 'ruby';
  if (/^lua\d+(?:\.\d+)*$/u.test(name)) return 'lua';
  if (/^perl\d+(?:\.\d+)*$/u.test(name)) return 'perl';
  if (/^(?:g?awk|mawk|nawk)\d+(?:\.\d+)*$/u.test(name)) return 'awk';
  if (/^pwsh\d+(?:\.\d+)*$/u.test(name)) return 'powershell';
  return Object.hasOwn(aliases, name) ? aliases[name] : undefined;
}

function envCommand(rest: string): string | undefined {
  const words = rest.replace(/^[\t ]+|[\t ]+$/gu, '').split(/[\t ]+/u);
  if (words.length === 1 && !words[0]!.startsWith('-') && !words[0]!.includes('=')) return words[0];
  if (words[0] !== '-S' || words.length < 2) return undefined;
  if (words.some(word => !executableToken(word))) return undefined;
  const command = words[1]!;
  if (command.startsWith('-') || command.includes('=')) return undefined;
  return command;
}

/** Returns a reviewed, canonical grammar identifier; it never executes the named command. */
export function shebangLanguage(firstLine: string): string | undefined {
  if (firstLine.length > MAX_SHEBANG_BYTES || Buffer.byteLength(firstLine, 'utf8') > MAX_SHEBANG_BYTES) return undefined;
  const line = firstLine.endsWith('\r') ? firstLine.slice(0, -1) : firstLine;
  if (!line.startsWith('#!') || /\p{Cc}/u.test(line.replace(/\t/gu, ''))) return undefined;
  const body = line.slice(2).replace(/^[\t ]*/u, '');
  const separator = body.search(/[\t ]/u);
  const command = separator < 0 ? body : body.slice(0, separator);
  const rest = separator < 0 ? '' : body.slice(separator).replace(/^[\t ]+/u, '');
  if (!executableToken(command)) return undefined;
  const base = command.split('/').at(-1);
  if (base === 'env') {
    const candidate = envCommand(rest);
    return candidate ? interpreterName(candidate) : undefined;
  }
  return interpreterName(command);
}
