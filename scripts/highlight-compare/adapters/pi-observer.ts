import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import tidyUi from '../../../src/index.ts';
import { SyntaxClient } from '../../../src/occipital/client.ts';
import { CardSources, type CardDisplayInput } from '../../../src/syntax/cards.ts';
import { registerCaptureProducer } from '../../../tests/fixtures/terminal-capture.mjs';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export default function comparisonObserver(pi: ExtensionAPI) {
  const start = SyntaxClient.prototype.start, updateDisplay = CardSources.prototype.updateDisplay;
  const preparations: object[] = [];
  const identities = new WeakMap<object, number>();
  const owners = new Map<number, { owner: WeakRef<object>; consumer: WeakRef<CardSources<object>> }>();
  let sequence = 0, stop: (() => void) | undefined;
  function observedDisplay(this: CardSources<object>, owner: object, input: CardDisplayInput): boolean {
    if (!identities.has(owner)) {
      const id = ++sequence; identities.set(owner, id);
      owners.set(id, { owner: new WeakRef(owner), consumer: new WeakRef(this) });
    }
    return updateDisplay.call(this, owner, input);
  }
  function observedStart(this: SyntaxClient): Promise<void> {
    const result = start.call(this), owner = new WeakRef(this);
    stop?.();
    stop = registerCaptureProducer(this, () => {
      const client = owner.deref();
      const views = [];
      for (const [id, entry] of owners) {
        const component = entry.owner.deref(), consumer = entry.consumer.deref();
        if (!component || !consumer || !client) { owners.delete(id); continue; }
        let view: object | undefined;
        const accepted = consumer.visit(component, (display, paint) => {
          const sources = consumer.identities(component).map(identity => {
            const source = client.sources.borrowSource(identity.key), basis = client.sources.displayBasis(identity.key);
            const ranges: [number, number][] = [];
            let textSha256: string | undefined, rangesAccepted = false;
            const basisAccepted = paint.basis(identity.key, (text, read) => {
              textSha256 = sha256(text);
              rangesAccepted = read((start, end) => ranges.push([start, end]));
            });
            return { ...identity, basisAccepted, rangesAccepted, textSha256, ranges,
              source: source && { sha256: sha256(source.text), bytes: source.utf8Bytes, complete: source.complete, version: source.version, generation: source.generation },
              status: client.sources.status(identity.key), work: client.sources.workStatus(identity.key),
              display: basis && { version: basis.version, exactVersion: basis.exactVersion, complete: basis.complete,
                generation: basis.generation, palette: basis.palette, rules: basis.rules, stamp: basis.stamp } };
          });
          view = { kind: display.kind, revision: display.revision,
            ...(display.kind === 'file' ? { path: display.path, preview: !!display.preview, omitted: !!display.omitted,
              displayMode: display.mode, error: display.error,
              rows: display.rows.map(row => ({ kind: row.kind, oldLine: row.old, newLine: row.next, text: row.region?.text })) } : {}),
            roles: Object.fromEntries(Object.entries(paint.roles).map(([name, style]) => [name, { open: style.open, close: style.close }])),
            origin: paint.origin, mode: paint.mode, publication: paint.publication, paintStamp: paint.paintStamp, sources };
        });
        views.push({ id, accepted, ...view });
      }
      return { client: client?.snapshot(), source: client?.sources.stats(), preparations, views };
    });
    return result;
  }
  CardSources.prototype.updateDisplay = observedDisplay;
  SyntaxClient.prototype.start = observedStart;
  pi.on('session_shutdown', () => {
    stop?.(); stop = undefined; preparations.length = 0; owners.clear();
    if (SyntaxClient.prototype.start === observedStart) SyntaxClient.prototype.start = start;
    if (CardSources.prototype.updateDisplay === observedDisplay) CardSources.prototype.updateDisplay = updateDisplay;
  });
  return tidyUi(pi, { cardPreparation: event => preparations.push({
    ...event, ...(event.phase === 'prepared' ? { outcomes: [...event.outcomes] } : {}),
  }) });
}
