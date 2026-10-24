import { fileURLToPath } from 'node:url';
import { workspaceRelativeTestFile, testEventKey } from './progress.mjs';

function completedStatus(data) {
  if (data.skip || data.details?.skip) return 'skipped';
  if (data.todo || data.details?.todo) return 'todo';
  return data.details?.error || data.error ? 'failed' : 'passed';
}

export default async function* progressReporter(events) {
  for await (const event of events) {
    if (event.type !== 'test:dequeue' && event.type !== 'test:complete') continue;
    const data = event.data ?? {};
    const file = workspaceRelativeTestFile(data.file);
    const rawName = typeof data.name === 'string' ? data.name : '(unnamed test)';
    const fileName = value => {
      if (typeof value !== 'string') return null;
      try { return value.startsWith('file:') ? fileURLToPath(value) : value; }
      catch { return null; }
    };
    const fileSuite = typeof data.file === 'string' && rawName === fileName(data.file);
    const name = fileSuite ? file : rawName.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
    const identity = { ...data, file, name };
    const record = {
      event: event.type === 'test:dequeue' ? 'test-start' : 'test-complete',
      key: testEventKey(identity),
      name,
      file,
      ...(Number.isInteger(data.line) ? { line: data.line } : {}),
      ...(Number.isInteger(data.column) ? { column: data.column } : {}),
      ...(Number.isInteger(data.nesting) ? { nesting: data.nesting } : {}),
      ...(Number.isInteger(data.testNumber) ? { testNumber: data.testNumber } : {}),
      kind: data.type === 'suite' || fileSuite ? 'suite' : 'test',
      at: new Date().toISOString(),
    };
    if (event.type === 'test:complete') {
      const durationMs = data.details?.duration_ms;
      record.status = completedStatus(data);
      record.durationMs = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
    }
    yield `${JSON.stringify(record)}\n`;
  }
}
