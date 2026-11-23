import type { ToolCallSnapshot, ToolCardKind } from '../tool-adapters/contracts.ts';
import type { ToolProducerPresenter } from './tool-producers.ts';
import type { ToolPresentationSessions } from './tool-sessions.ts';
import { selectToolPresentationIntent, type ToolPresentationIntent } from './tool-intents.ts';

export interface ToolPresentationFacts<Owner> {
  active(): boolean;
  name(owner: Owner): string;
  toolCallId(owner: Owner): string;
  expanded(owner: Owner): boolean;
  hidden(owner: Owner): boolean;
  attached(owner: Owner): boolean;
}

export interface ToolPresentationOverrides {
  cards: ReadonlySet<string>;
  compact: ReadonlySet<string>;
  native: ReadonlySet<string>;
}

export class ToolPresentationPolicy<Owner extends object> {
  private readonly producer: ToolProducerPresenter<Owner>;
  private readonly sessions: ToolPresentationSessions<Owner>;
  private readonly facts: ToolPresentationFacts<Owner>;
  private readonly overrides: ToolPresentationOverrides;

  constructor(producer: ToolProducerPresenter<Owner>, sessions: ToolPresentationSessions<Owner>,
    facts: ToolPresentationFacts<Owner>, overrides: ToolPresentationOverrides) {
    this.producer = producer;
    this.sessions = sessions;
    this.facts = facts;
    this.overrides = overrides;
  }

  kind(owner: Owner): ToolCardKind {
    return this.producer.kind(owner);
  }

  fileTool(owner: Owner): boolean {
    const kind = this.kind(owner);
    return kind === 'edit' || kind === 'write';
  }

  filePresentationTool(owner: Owner): boolean {
    const kind = this.kind(owner);
    return kind === 'read' || kind === 'edit' || kind === 'write';
  }

  fileSucceeded(owner: Owner): boolean {
    const call = this.producer.capture(owner), kind = this.producer.kindFrom(call);
    const fileKind = kind === 'read' || kind === 'edit' || kind === 'write';
    return fileKind && call.hasResult && !call.partial && !call.resultFailed;
  }

  hasImage(owner: Owner): boolean {
    return this.producer.hasImage(owner);
  }

  filePresentationEligible(owner: Owner): boolean {
    const call = this.producer.capture(owner);
    return this.fileEligible(owner, call, this.producer.kindFrom(call));
  }

  private fileEligible(owner: Owner, call: ToolCallSnapshot, kind: ToolCardKind): boolean {
    if (kind !== 'read' && kind !== 'edit' && kind !== 'write') return false;
    if (!this.facts.active() || this.facts.hidden(owner)) return false;
    if (kind === 'read' ? !this.overrides.compact.has(call.name) && this.overrides.native.has(call.name)
      : this.overrides.compact.has(call.name) || this.overrides.native.has(call.name)) return false;
    if (call.hasResult && !call.partial && !call.resultFailed && !this.producer.readerFrom(call).path()) return false;
    return kind === 'read' || !this.hasImage(owner);
  }

  readPresentationMode(owner: Owner): 'full' | undefined {
    const call = this.producer.capture(owner);
    return this.producer.kindFrom(call) === 'read' && this.fileEligible(owner, call, 'read') && this.facts.expanded(owner) ? 'full' : undefined;
  }

  filePreviewMode(owner: Owner): 'preview' | 'full' | undefined {
    const call = this.producer.capture(owner), kind = this.producer.kindFrom(call);
    return kind === 'edit' || kind === 'write' ? this.fileModeFrom(owner, call, kind) : undefined;
  }

  fileMode(owner: Owner): 'preview' | 'full' | undefined {
    const call = this.producer.capture(owner);
    return this.fileModeFrom(owner, call, this.producer.kindFrom(call));
  }

  private fileModeFrom(owner: Owner, call: ToolCallSnapshot, kind: ToolCardKind): 'preview' | 'full' | undefined {
    if (!this.fileEligible(owner, call, kind)) return undefined;
    if (kind === 'read') return this.facts.expanded(owner) ? 'full' : undefined;
    return this.sessions.fileMode(owner, this.facts.toolCallId(owner), this.facts.expanded(owner));
  }

  eligible(owner: Owner): boolean {
    if (!this.facts.active() || this.facts.hidden(owner) || this.facts.expanded(owner)) return false;
    const kind = this.kind(owner), name = this.facts.name(owner);
    const selected = kind === 'read'
      ? this.overrides.compact.has(name) || !this.overrides.native.has(name)
      : this.overrides.compact.has(name) || !this.overrides.cards.has(name) ||
        ((kind === 'edit' || kind === 'write') && !this.overrides.native.has(name) && !this.fileSucceeded(owner));
    return selected && (kind === 'read' || !this.hasImage(owner));
  }

  bashSourceSelected(owner: Owner): boolean {
    return !this.overrides.compact.has(this.facts.name(owner)) && !this.overrides.native.has(this.facts.name(owner));
  }

  ownedBash(owner: Owner): boolean {
    const name = this.facts.name(owner);
    return this.facts.active() && this.kind(owner) === 'bash' && !this.facts.hidden(owner) &&
      !this.overrides.compact.has(name) && !this.overrides.native.has(name) && !this.hasImage(owner) && this.facts.attached(owner);
  }

  compactIntent(owner: Owner, width: number): boolean {
    if (!this.eligible(owner)) return false;
    return width < 1 || selectToolPresentationIntent(width, false, false, true) === 'compact';
  }

  bashIntent(owner: Owner, width: number): boolean {
    return this.ownedBash(owner) && selectToolPresentationIntent(width, false, true, false) === 'bash';
  }

  fileIntent(owner: Owner, width: number): ToolPresentationIntent {
    const call = this.producer.capture(owner), kind = this.producer.kindFrom(call);
    const selected = this.fileEligible(owner, call, kind) && (kind !== 'read' || this.facts.expanded(owner));
    return selectToolPresentationIntent(width, selected, false, false);
  }
}
