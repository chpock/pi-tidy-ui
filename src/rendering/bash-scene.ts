import type { CardRole } from '../appearance/card-roles.ts';
import type { PreparedCard } from './card-values.ts';
import type { SceneConstruction } from './scene-model.ts';

export function buildBashScene(display: Extract<PreparedCard, { kind: 'bash' }>, expanded: boolean | undefined, build: SceneConstruction): void {
  const current = build.scene;
  if (display.regions.description) build.lines('description', 0, 'service', 'bash');
  if (display.regions.heading) build.lines('heading', 0, 'service', 'bash');
  if (current.rows.length) build.append(build.empty());
  build.lines('command', 0, 'title', 'bash', true);
  const section = (first: number, end: number, role: CardRole) => {
    const start = current.rows.length; let count = 0;
    for (let i = first; i < end && (expanded || count < 11); i++) {
      if (!display.regions.output[i]) {
        // Empty service rows have no measurement, but are one visual row.
        build.append(build.empty()); count++; continue;
      }
      // Bound reflow by the remaining preview and its independent overflow proof.
      const id = build.entry('output', i, role, build.available, 'bash', false, expanded ? undefined : 11 - count), e = current.entries[id]!;
      for (let row = 0; row < e.layout.rowCount && (expanded || count < 11); row++, count++) build.append({ ...build.empty(), entry: id, row });
    }
    const overflow = count > 10;
    if (overflow && !expanded) {
      build.removeLastRow();
      while (current.rows.length > start) {
        const c = current.rows[current.rows.length - 1]!.left;
        if (c.entry >= 0 && !current.entries[c.entry]!.blank[c.row]) break;
        build.removeLastRow();
      }
      build.append(build.empty(build.available, -2));
    }
    if (current.rows.length > start) build.insertEmptyRow(start);
    return overflow || !!expanded && count > 0;
  };
  const s = display.service, output = section(s.first, s.last, 'output');
  if (display.regions.footer) { build.append(build.empty()); build.lines('footer', 0, display.service.error ? 'error' : 'footer', 'bash'); }
  current.expandable = section(s.reminder, s.end, 'reminder') || output;
}
