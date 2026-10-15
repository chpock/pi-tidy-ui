import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const notice = `\x1b]777;tidy-test;${Buffer.from(JSON.stringify({ type: 'journal' })).toString('base64')}\x07`;

export function createEventRecorder(output: string): (event: unknown) => void {
  const path = join(output, 'events.jsonl');
  return event => {
    appendFileSync(path, JSON.stringify(event) + '\n');
    process.stdout.write(notice);
  };
}

const diagnosticNotice = `\x1b]777;tidy-test;${Buffer.from(JSON.stringify({ type: 'diagnostic' })).toString('base64')}\x07`;

export function writeDiagnosticJson(output: string, name: string, value: unknown, space?: number): void {
  writeFileSync(join(output, `${name}.json`), JSON.stringify(value, null, space));
  process.stdout.write(diagnosticNotice);
}
