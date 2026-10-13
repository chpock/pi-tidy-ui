// Research corpus: synthetic source and a snapshot of real pi-tidy-ui source.
import { readFileSync } from 'node:fs';
export const samples = {
  typescript: 'const result: User = client.fetch(user.id) ?? fallback;\nfunction greet(name: string): string { return `hello ${name}`; }\n// Unicode: 😀 é 中文\n',
  python: 'result = client.fetch(user.id) if user.active else fallback\ndef greet(name: str) -> str:\n    return f"hello {name}"\n# Unicode: 😀 é 中文\n',
  bash: 'name="world"\nprintf "%s\\n" "$name" | cat\ncat <<\'EOF\'\n$NOT_INTERPOLATED # literal, not a comment\nEOF\necho "$(date)"\n# Unicode: 😀 é 中文\n',
  rust: 'fn example() { let result: User = client.fetch(user.id).unwrap_or(fallback); }\nfn greet(name: &str) -> String { format!("hello {}", name) }\n// Unicode: 😀 é 中文\n',
  javascript: 'const result = client.fetch(user.id) ?? fallback;\nconst greet = name => `hello ${name}`;\n',
  tsx: 'const view = <Panel title={user.name}>{format(user.id)}</Panel>;\n',
  html: '<div class="example">Hello</div>\n<script>const result = client.fetch(user.id);</script>\n<style>.example { color: red; }</style>\n',
  css: '.example:hover { color: red; padding: 2px; --value: 3; }\n',
  json: '{"result": true, "name": "hello", "items": [1, 2]}\n',
};
export const languages = ['typescript', 'python', 'bash', 'rust'];
export const unit = {
  typescript: i => `const result${i}: User = client.fetch(user.id) ?? fallback;`,
  python: i => `result${i} = client.fetch(user.id) if user.active else fallback`,
  bash: i => `printf '%s\\n' "${i}:$name" | cat`,
  rust: i => `let result${i}: User = client.fetch(user.id).unwrap_or(fallback);`,
};
export function source(lang, lines) { const body = Array.from({length: lines}, (_, i) => unit[lang](i)).join('\n'); return lang === 'rust' ? `fn main() {\n${body}\n}` : body; }
export const realSource = readFileSync(new URL('./file-card-snapshot.txt', import.meta.url), 'utf8');
export const streamSource = {
  ...Object.fromEntries(languages.map(lang => [lang, samples[lang] + source(lang, 120)])),
  'typescript-function': 'function growing(user: User) {\n' + source('typescript', 120) + '\nreturn user;\n}',
};
export const appendChunks = text => { const n = Math.ceil(text.length / 32); return Array.from({length: Math.ceil(text.length / n)}, (_, i) => text.slice(i * n, (i + 1) * n)); };
