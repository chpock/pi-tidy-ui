import { layoutCard, type BashPaintProof, type CardLayout, type CardRows } from '../rendering/card-layout.ts';
import type { PreparedCard, ReadyCardPaint } from '../rendering/card-values.ts';
import type { GeometryFunding } from '../resources/data-budget.ts';
import type { CacheEntry, RenderCache } from '../render-cache.ts';
import type { FilePreviewMode } from '../cards/file-preview-mode.ts';
import type { ToolProducerPresenter } from './tool-producers.ts';
import type { PreparedLayout, ToolPresentationSessions } from './tool-sessions.ts';

type PreparedRelease = {
  geometry?: ReturnType<CardLayout['cleanupReceipt']>;
  output: ReturnType<CardRows['cleanupReceipt']>;
};

function preparedRelease(receipts: PreparedRelease) {
  return { release() { receipts.geometry?.release(); receipts.geometry = undefined; receipts.output.release(); } };
}

export interface PreparedLayoutPresenterPorts<Owner extends object> {
  sessions: ToolPresentationSessions<Owner>;
  ordinaryCache: RenderCache;
  cardCache: RenderCache;
  expanded(owner: Owner): boolean;
  kind: ToolProducerPresenter<Owner>['kind'];
  active(): boolean;
  outputPadding(): number;
  funding(): GeometryFunding | undefined;
  /** True only if consume ran and its borrowed display and paint stayed current through return. */
  visit(owner: Owner, consume: (display: PreparedCard, paint: ReadyCardPaint) => void): boolean;
  identities(owner: Owner): readonly { key: string; version: number }[];
  fileMode(owner: Owner): FilePreviewMode | undefined;
  unsupportedFullFile(owner: Owner): boolean;
  refuse(owner: Owner, cause: string): void;
  observePalette(owner: Owner, origin: 'owned' | 'pi'): void;
  displayBasis(key: string): unknown;
  piDisplay(key: string): { styleDirectives?: unknown } | undefined;
  decision(owner: Owner, choice: string, width: number, rows: number, fields: { selected: string; origin: 'owned' | 'pi' }): void;
}

export class PreparedLayoutPresenter<Owner extends object> {
  private cleanup = new WeakMap<CacheEntry<PreparedLayout>, PreparedRelease>();
  private readonly ports: PreparedLayoutPresenterPorts<Owner>;

  constructor(ports: PreparedLayoutPresenterPorts<Owner>) {
    this.ports = ports;
  }

  prepare(owner: Owner, width: number): PreparedLayout | undefined {
    const { ports } = this;
    if (!ports.sessions.hasCurrentDisplay(owner)) return;
    const previousEntry = ports.sessions.preparedLayout(owner)?.entry;
    const previous = previousEntry?.value;
    const padding = ports.outputPadding();
    const expandedAtEntry = ports.expanded(owner);
    let kind: ReturnType<typeof ports.kind>;

    let funding: GeometryFunding | undefined;
    let scene: CardLayout | undefined;
    let output: CardRows | undefined;
    let candidate: PreparedLayout | undefined;
    let adopted = false;
    let nativeFile = false;
    let historicalBash = false;
    try {
      const accepted = ports.visit(owner, (display, paint) => {
        if (display.kind === 'file' && display.mode === undefined) { nativeFile = true; return; }
        ports.observePalette(owner, paint.origin);
        const expanded = display.kind === 'bash' ? expandedAtEntry : display.preview !== true;
        const sameGeometry = previous?.scene.isRetained && previous.width === width && previous.padding === padding
          && previous.expanded === expanded && previous.geometryStamp === display.geometryStamp;
        if (sameGeometry && previous.output.isValid && previous.paintStamp === paint.paintStamp) { candidate = previous; return; }
        kind = ports.kind(owner);
        if (!kind) return;
        funding = ports.funding();
        if (!funding) return;
        scene = sameGeometry ? previous.scene : layoutCard(display, { width, outputPad: padding, expanded }, funding);
        if (!scene) return;
        let proof: BashPaintProof | undefined;
        if (display.kind === 'bash') {
          const key = ports.identities(owner)[0]?.key;
          const eligibleBytes = paint.bashPrefixBytes;
          if (key && eligibleBytes) {
            historicalBash = paint.basis(key, (_text, ranges) => { proof = { ranges, eligibleBytes }; });
          }
        }
        output = scene.paint(display, paint, funding, proof);
        if (!output) return;
        candidate = {
          scene, output, width, padding, expanded,
          geometryStamp: display.geometryStamp,
          paintStamp: paint.paintStamp,
          publication: paint.publication,
          origin: paint.origin,
        };
        ports.sessions.observeConstruction('plan');
      });

      const filePresentation = kind === 'read' || kind === 'edit' || kind === 'write';
      if (accepted && nativeFile) ports.sessions.dropPreparedLayout(owner);
      if (!accepted || !candidate || !ports.active()) {
        if (ports.active() && accepted && !candidate && filePresentation && !nativeFile) {
          if (ports.fileMode(owner) === 'full' && !ports.unsupportedFullFile(owner)) ports.sessions.dropPreparedLayout(owner);
          ports.refuse(owner, funding ? 'file geometry or paint funding refused' : 'file geometry funding refused');
        }
        return undefined;
      }

      const currentState = ports.sessions.syntax(owner);
      if (currentState) { currentState.owned = candidate.origin === 'owned'; currentState.refused = false; }
      if (candidate === previous) {
        ports.sessions.preparedLayout(owner)?.pool.get(previousEntry!);
        return previous;
      }

      let rows: string[] | undefined;
      if (!candidate.output.withRows(value => { rows = value; }) || !rows) {
        if (filePresentation) {
          if (ports.fileMode(owner) === 'full' && !ports.unsupportedFullFile(owner)) ports.sessions.dropPreparedLayout(owner);
          ports.refuse(owner, 'file row publication refused');
        }
        return undefined;
      }

      const oldRelease = previousEntry && this.cleanup.get(previousEntry);
      const release: PreparedRelease = {
        geometry: candidate.scene.cleanupReceipt(),
        output: candidate.output.cleanupReceipt(),
      };
      const pool = candidate.scene.framed ? ports.cardCache : ports.ordinaryCache;
      pool.get(undefined);
      const entry = pool.put(candidate, rows, kind!, preparedRelease(release));
      if (candidate.scene === previous?.scene && oldRelease) oldRelease.geometry = undefined;
      this.cleanup.set(entry, release);
      ports.sessions.dropPreparedLayout(owner);
      ports.sessions.setPreparedLayout(owner, entry, pool);
      adopted = true;

      const identity = ports.identities(owner)[0];
      const basis = identity && ports.displayBasis(identity.key);
      const pi = identity && ports.piDisplay(identity.key);
      const selected = kind === 'bash' ? historicalBash ? 'historical-native-prefix' : 'toolTitle'
        : basis ? 'exact-native' : pi ? pi.styleDirectives ? 'styled-pi' : 'plain-pi' : 'waiting';
      ports.decision(owner, selected === 'historical-native-prefix' ? 'Validated historical-prefix display, not parser authority'
        : selected === 'plain-pi' ? 'Pi returned plain text; complete card palette supplies neutral ink'
          : selected === 'waiting' ? 'Native work is queued, unsettled or uncertain; full text shown without duplicate Pi classification'
            : 'Complete prepared card palette and source display selected', width, candidate.output.rowCount,
        { selected, origin: candidate.origin });
      return candidate;
    } finally {
      if (!adopted) { output?.dispose(); if (scene !== previous?.scene) scene?.dispose(); }
    }
  }
}
