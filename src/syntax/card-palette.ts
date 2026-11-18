import type { CardDisplayInput } from '../cards/display-input.ts';
import type { CardSourcePort } from '../highlighting/source-ports.ts';
import { fingerprintRules } from '../occipital/style-rules.ts';
import type { GeometryFunding } from '../resources/data-budget.ts';
import { resolveTheme, type ThemeDescription } from '../themes/selection.ts';
import type { PaletteInputLease } from './pi-input.ts';
import { createSemanticRuleDefinition } from './semantic-rules.ts';
import type { SyntaxSourceClient } from './work.ts';

type PaletteInput = Pick<CardDisplayInput, 'palette' | 'mode'>;

export function followPiPalette(): ThemeDescription { return resolveTheme({ kind: 'pi', variant: 'dark' }).effective; }
function paletteId(palette: ThemeDescription): string { return palette.kind === 'pi' ? 'pi' : palette.id; }

export function groupKey(palette: ThemeDescription, input: PaletteInput): string {
  const color = palette.kind === 'pi' ? `pi:${input.palette}` : `theme:${palette.id}:${palette.fingerprint}`;
  return `${color}:${input.mode}`;
}

export function matchesLease(lease: PaletteInputLease | undefined, palette: ThemeDescription, input: PaletteInput): lease is PaletteInputLease {
  return lease?.paletteId === paletteId(palette) && lease.paletteRevision === input.palette && lease.terminalMode === input.mode;
}

/** Consumer-wide selection; acquiring or installing a card's lease is not part of binding. */
export class CardPaletteSelection {
  #requested = followPiPalette();
  #metadata = '';
  #metadataSelection = '';
  #inputRevision?: number;
  #installed = '';
  #installedRules = '';
  #revision = 0;
  #enabled = true;
  #providerReady = false;
  readonly #definition = createSemanticRuleDefinition();
  readonly #rules = fingerprintRules(this.#definition);
  readonly #source: Pick<CardSourcePort, 'setStyleSelection'>;

  constructor(source: Pick<CardSourcePort, 'setStyleSelection'>) { this.#source = source; }
  get requested(): ThemeDescription { return this.#requested; }
  get revision(): number { return this.#revision; }
  get enabled(): boolean { return this.#enabled; }
  get providerReady(): boolean { return this.#providerReady; }

  inputKey(palette: ThemeDescription, input: PaletteInput): string {
    return `${paletteId(palette)}:${input.palette}:${input.mode}`;
  }

  effective(input?: PaletteInput, fallbackTag?: string): ThemeDescription {
    return input && fallbackTag === this.inputKey(this.#requested, input) ? followPiPalette() : this.#requested;
  }

  sync(snapshot: ReturnType<SyntaxSourceClient['snapshot']>, revision?: number): boolean {
    const palette = this.#requested = snapshot.effective ?? followPiPalette();
    this.#enabled = snapshot.enabled;
    this.#providerReady = snapshot.provider.availability === 'ready';
    const selection = JSON.stringify([snapshot.enabled, palette.kind, palette.id, palette.fingerprint]);
    const metadata = JSON.stringify([snapshot.enabled, snapshot.provider.availability, snapshot.provider.generation, selection]);
    if (metadata === this.#metadata && (revision === undefined || revision === this.#inputRevision)) return false;
    if (this.#metadata && selection !== this.#metadataSelection) this.#revision++;
    if (revision !== undefined) this.#inputRevision = revision;
    this.#metadataSelection = selection;
    this.#metadata = metadata;
    return true;
  }

  accepts(palette: string, rules: string): boolean { return palette === this.#installed && rules === this.#installedRules; }

  bind(lease: PaletteInputLease | undefined, palette: ThemeDescription, input: PaletteInput, key: string, funding: GeometryFunding): void {
    if (!matchesLease(lease, palette, input)) return;
    if (this.accepts(key, this.#rules)) return;
    let accepted = false;
    lease.visit(read => { accepted = this.#source.setStyleSelection({ definition: this.#definition, bindingRevision: input.palette,
      palette: key, bindings: read.bindings, roles: read.roles }); }, funding.grant);
    if (accepted) { this.#installed = key; this.#installedRules = this.#rules; this.#revision++; }
  }
}
