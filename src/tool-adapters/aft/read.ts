import { prepareFileCard, sourceRows } from '../../file-card.ts';
import type { FileCardInput } from '../../file-card.ts';
import type { FileToolReader, ToolAdapter, ToolCallSnapshot } from '../contracts.ts';
import { aftFileReader } from './file.ts';
import { resultDetails as details } from '../shared/result-details.ts';

function textParts(call: ToolCallSnapshot): string[] {
  return call.result?.content?.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text!) ?? [];
}
function validCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function numberedMetadata(call: ToolCallSnapshot) {
  const data = details(call), content = data.content, start = data.start_line, end = data.end_line, count = data.lines_read;
  if (data.success !== true || typeof content !== 'string' || !validCoordinate(start) || start < 1 || !validCoordinate(end) ||
    !validCoordinate(count) || count < 1 || end - start + 1 !== count) return undefined;
  return { content, start, count };
}
function readBlockMatches(text: string, content: string): boolean {
  return text.startsWith(content) && (text.length === content.length || /[\r\n]/u.test(content.charAt(content.length - 1)) ||
    /[\r\n]/u.test(text.charAt(content.length)));
}
function aftRows(call: ToolCallSnapshot) {
  const text = textParts(call).join('\n'), metadata = numberedMetadata(call);
  if (metadata && readBlockMatches(text, metadata.content)) {
    const supplied = Array.from(sourceRows(metadata.content));
    if (supplied.length >= metadata.count) {
      const rows: { text: string; line?: number }[] = [];
      let valid = true;
      for (let index = 0; index < metadata.count; index++) {
        const match = /^ *(\d+): (.*)$/su.exec(supplied[index]!);
        if (!match || match[1] !== String(metadata.start + index)) { valid = false; break; }
        rows.push({ text: match[2]!, line: metadata.start + index });
      }
      const saved = Array.from(sourceRows(text));
      for (let index = metadata.count; valid && index < saved.length; index++) {
        if (/^ *\d+: /u.test(saved[index]!)) { valid = false; break; }
        rows.push({ text: saved[index]! });
      }
      if (valid) return rows;
    }
  }
  const rawOffset = call.args.offset;
  const offset = typeof rawOffset === 'number' && Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 1;
  return Array.from(sourceRows(text), (value, index) => ({ text: value, line: offset + index }));
}
function aftSource(base: FileToolReader, call: ToolCallSnapshot, mode: 'full' | 'preview') {
  const ordinary = base.source(mode);
  if (mode === 'preview') return ordinary;
  const metadata = numberedMetadata(call);
  return metadata ? [...ordinary, metadata.content, metadata.start, metadata.count] : ordinary;
}

export function aftReadAdapter(): ToolAdapter {
  return {
    names: ['read'],
    kind: 'read',
    matches: call => {
      const data = details(call);
      return ['success', 'start_line', 'end_line', 'lines_read'].some(key => Object.hasOwn(data, key));
    },
    create(call) {
      const base = aftFileReader(call, 'read');
      return {
        ...base,
        source: mode => aftSource(base, call, mode),
        prepareFile(mode, logicalOnly = false) {
          const path = base.path();
          if (!path) return undefined;
          const input: FileCardInput = { kind: 'read', path, complete: call.hasResult && !call.partial, failed: call.resultFailed,
            viewMode: mode, readRows: mode === 'preview' ? [] : aftRows(call) };
          return prepareFileCard(input, logicalOnly);
        },
      };
    },
  };
}
