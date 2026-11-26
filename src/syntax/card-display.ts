import { fileHeading, readHeading } from '../file-card.ts';
import { prepareBashRegions, prepareCommand } from '../cards/bash-preparation.ts';
import { prepareFileRows, prepareFileServices } from '../cards/file-preparation.ts';
import type { PreparedFileCard } from '../cards/file-model.ts';
import type { CardMeasurements } from '../cards/preparation.ts';
import type { CardDisplayInput } from '../cards/display-input.ts';
import { measure, prepareMeasuredAppend, type MeasuredAppend } from '../rendering/measured-rows.ts';
import type { PreparedCard, PreparedRegion } from '../rendering/card-values.ts';
import type { DataCleanupReceipt, GeometryFunding } from '../resources/data-budget.ts';

type BashInput = Extract<CardDisplayInput, { kind: 'bash' }>;
type FileInput = Extract<CardDisplayInput, { kind: 'file' }>;
type FileDisplay = Extract<PreparedCard, { kind: 'file' }>;
type View = 'full' | 'preview' | 'bash';
type DisplayRevisions = { readonly sourceRevision: number; readonly serviceRevision: number; readonly expanded?: boolean };
type PriorDisplay = DisplayRevisions & { readonly input?: Pick<CardDisplayInput, 'cwd'>; readonly display?: PreparedCard; readonly file?: PreparedFileCard };
export type DisplayEntry = { readonly nextView: View; readonly previousView: View; readonly expanded: boolean; readonly refresh: boolean; readonly refreshInput: boolean };
type DisplayContents = { readonly display: PreparedCard; readonly file?: PreparedFileCard; readonly bashSourceEligible?: boolean };
export type BuiltDisplay = DisplayContents & {
  adoptMeasurements(previous: ReadonlySet<DataCleanupReceipt>): Set<DataCleanupReceipt> | undefined;
};

function view(input?: CardDisplayInput): View { return input?.kind === 'file' ? input.viewMode ?? 'full' : 'bash'; }

export function displayEntry(previous: DisplayRevisions & { readonly revision: number; readonly input?: CardDisplayInput }, input: CardDisplayInput): DisplayEntry {
  const previousView = view(previous.input), nextView = view(input);
  const expanded = input.kind === 'bash' && input.reader.call.expanded;
  const refreshInput = input.kind === 'file' && previous.input?.kind === 'file' && previous.sourceRevision === input.sourceRevision
    && previous.serviceRevision === input.serviceRevision && previousView === nextView;
  const refresh = previous.revision === input.revision && previous.expanded === expanded && previousView === nextView
    && (previous.input?.palette === input.palette && previous.input.mode === input.mode || refreshInput);
  return { previousView, nextView, expanded, refresh, refreshInput };
}

export function reuseFileDescriptor(previous: Pick<PriorDisplay, 'sourceRevision' | 'display' | 'file'> & { readonly input?: CardDisplayInput },
  input: CardDisplayInput, entry: DisplayEntry): boolean {
  return input.kind === 'file' && previous.display?.kind === 'file' && previous.input?.kind === 'file'
    && previous.sourceRevision === input.sourceRevision && entry.previousView === entry.nextView && !!previous.file;
}

function collectMeasurements(display: PreparedCard, take: (region?: PreparedRegion) => void): void {
  if (display.kind === 'bash') {
    const { command, regions } = display;
    take(command); take(regions.description); take(regions.heading);
    for (const region of regions.output) take(region);
    take(regions.notice); take(regions.footer);
  } else {
    take(display.heading); take(display.note);
    for (const region of display.diagnostics) take(region);
    for (const row of display.rows) take(row.region);
  }
}

const refused = Symbol('card allocation refused');

/** Owns only the measurements created by this synchronous construction. */
export function beginDisplayBuild(funding: GeometryFunding, ticketId: number, nextGeometry: () => number) {
  const created = new Set<DataCleanupReceipt>();
  let append: MeasuredAppend | undefined;
  const dispose = () => {
    append?.dispose(); append = undefined;
    for (const receipt of created) receipt.release();
    created.clear();
  };
  const measurements: CardMeasurements = {
    region(text, wrap) {
      const measured = measure(text, funding.budget, funding.grant, wrap);
      if (!measured) throw refused;
      created.add(measured.cleanupReceipt());
      return Object.freeze({ text, measured });
    },
    append(previous, text) {
      append = prepareMeasuredAppend(previous.measured, text, funding.grant);
      if (!append) throw refused;
      return Object.freeze({ text, measured: append.measured });
    },
  };
  function build(input: CardDisplayInput, previous: PriorDisplay, entry: DisplayEntry): BuiltDisplay | undefined {
    try {
      const old = previous.display;
      const built = input.kind === 'bash' ? buildBashDisplay(input, previous, old, entry.expanded, measurements, nextGeometry)
        : buildFileDisplay(input, previous, old, entry.previousView === entry.nextView, measurements, ticketId, nextGeometry);
      return { ...built, adoptMeasurements(previousMeasured) {
        if (append && !append.commit()) return undefined;
        const used = new Set<DataCleanupReceipt>();
        collectMeasurements(built.display, region => { if (region) used.add(region.measured.cleanupReceipt()); });
        for (const receipt of previousMeasured) if (!used.has(receipt)) receipt.release();
        created.clear();
        return used;
      } };
    } catch (error) {
      if (error !== refused) throw error;
      return undefined;
    }
  }
  return { build, dispose };
}

function buildBashDisplay(input: BashInput, previous: PriorDisplay, old: PreparedCard | undefined, expanded: boolean,
  measurements: CardMeasurements, nextGeometry: () => number): DisplayContents {
  const prior = old?.kind === 'bash' ? old : undefined;
  const sameSource = prior && previous.sourceRevision === input.sourceRevision;
  const source = sameSource ? undefined : input.reader.command();
  const logical = sameSource ? prior.command.text : source ?? '';
  const command = prepareCommand(logical, prior?.command, measurements);
  const sameService = prior && previous.serviceRevision === input.serviceRevision;
  const service = sameService ? prior.service : input.reader.prepareService(input.directory);
  const regions = sameService && previous.expanded === expanded ? prior.regions : prepareBashRegions(service, expanded, prior?.regions, measurements);
  const sameGeometry = prior && command === prior.command && regions === prior.regions;
  return { display: Object.freeze({ kind: 'bash', revision: input.revision, geometryStamp: sameGeometry ? prior.geometryStamp : nextGeometry(), command, service, regions }),
    bashSourceEligible: sameSource ? undefined : source !== undefined };
}

function buildFileDisplay(input: FileInput, previous: PriorDisplay, old: PreparedCard | undefined, sameView: boolean,
  measurements: CardMeasurements, ticketId: number, nextGeometry: () => number): DisplayContents {
  const prior = old?.kind === 'file' ? old : undefined;
  const file = previous.sourceRevision === input.sourceRevision && sameView && previous.file ? previous.file : input.reader.prepareFile(input.viewMode ?? 'full', true);
  const error = !input.reader.call.partial && input.reader.failed;
  const { diagnostics, note } = prepareFileServices({ file, previous: prior, preview: input.viewMode === 'preview', diagnostics: input.diagnostics,
    sameService: previous.serviceRevision === input.serviceRevision && sameView, metadata: input.reader }, measurements);
  if (prior && file === previous.file && sameView)
    return { file, display: reuseFileRows(input, previous, prior, file, { diagnostics, note, error }, measurements, nextGeometry) };
  const rows = prepareFileRows(file, ticketId, measurements);
  return { file, display: Object.freeze({ kind: 'file', revision: input.revision, geometryStamp: nextGeometry(), path: file?.path, label: file?.view.label,
    mode: file?.view.mode, preview: file?.view.preview, omitted: file?.view.omitted, note, error, diagnostics,
    heading: file ? measurements.region(headingText(file, input), 'fragments') : undefined, rows }) };
}

function reuseFileRows(input: FileInput, previous: Pick<PriorDisplay, 'input'>, old: FileDisplay, file: PreparedFileCard | undefined,
  service: Pick<FileDisplay, 'error' | 'note' | 'diagnostics'>, measurements: CardMeasurements, nextGeometry: () => number): FileDisplay {
  const text = file ? headingText(file, input) : undefined;
  const heading = previous.input?.cwd === input.cwd ? old.heading : text ? measurements.region(text, 'fragments') : undefined;
  const sameGeometry = heading === old.heading && service.diagnostics === old.diagnostics && service.note === old.note;
  return Object.freeze({ ...old, revision: input.revision, heading, ...service, geometryStamp: sameGeometry ? old.geometryStamp : nextGeometry() });
}

function headingText(file: PreparedFileCard, input: FileInput): string {
  return input.reader.kind === 'read' ? readHeading(file.path, input.cwd) : fileHeading(file.path, input.cwd, file.view.label);
}
