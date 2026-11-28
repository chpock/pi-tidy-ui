import { captureToolCall, createToolReader, isToolArgs, toolCards } from '../tool-adapters/registry.ts';
import type { ToolCallObservation } from '../tool-adapters/registry.ts';
import type { FileChangeClass } from '../cards/file-model.ts';
import type { FileToolReader, ToolCallSnapshot, ToolReader } from '../tool-adapters/contracts.ts';
import type { ToolCallStates, ToolCallState } from './tool-call-state.ts';

export type ToolFieldAccessors<Owner> = {
  [Key in keyof ToolCallObservation]-?: (owner: Owner) => ToolCallObservation[Key];
};

export class ToolProducerPresenter<Owner extends object> {
  private readonly fields: ToolFieldAccessors<Owner>;
  private readonly calls: ToolCallStates<Owner>;

  constructor(fields: ToolFieldAccessors<Owner>, calls: ToolCallStates<Owner>) {
    this.fields = fields;
    this.calls = calls;
  }

  private readInput(owner: Owner, previous?: ToolCallState['input']): NonNullable<ToolCallState['input']> {
    const name = this.fields.name(owner), args = this.fields.args(owner);
    if (previous?.name === name && previous.args === args) return previous;
    const valid = isToolArgs(args);
    return { name, args, valid, kind: valid ? toolCards.get(name)?.kind : undefined };
  }

  private read(owner: Owner, input: NonNullable<ToolCallState['input']>): ToolCallSnapshot {
    return captureToolCall({
      name: input.name,
      id: this.fields.id(owner),
      args: input.args,
      result: this.fields.result(owner),
      partial: this.fields.partial(owner),
      expanded: this.fields.expanded(owner),
      executionStarted: this.fields.executionStarted(owner),
      argsComplete: this.fields.argsComplete(owner),
    });
  }

  capture(owner: Owner): ToolCallSnapshot {
    const state = this.state(owner);
    return state.snapshot ??= this.read(owner, state.input ??= this.readInput(owner));
  }

  private state(owner: Owner): ToolCallState { return this.calls.observe(owner, this.fields.id(owner)); }

  updating(owner: Owner): boolean { return !!this.calls.peek(owner)?.nativeUpdateDepth; }

  nativeUpdate<T>(owner: Owner, inputsMayHaveChanged: boolean, apply: () => T): T {
    const state = this.state(owner);
    if (inputsMayHaveChanged) state.nativeInputsDirty = true;
    state.nativeUpdateDepth = (state.nativeUpdateDepth ?? 0) + 1;
    try { return apply(); }
    finally { state.nativeUpdateDepth--; }
  }

  refresh(owner: Owner, refreshInputs = false): ToolCallSnapshot {
    const current = this.state(owner);
    const input = this.readInput(owner, current.input), next = this.read(owner, input);
    const inputsMayHaveChanged = refreshInputs || current.nativeInputsDirty === true;
    current.nativeInputsDirty = false;
    if (current.input && current.input.name !== input.name) this.calls.detach(owner);
    const state = this.calls.observe(owner, next.id), prior = state.snapshot;
    state.input = input;
    if (inputsMayHaveChanged || !prior || prior.args !== next.args || prior.result !== next.result || prior.name !== next.name ||
      prior.expanded !== next.expanded || prior.partial !== next.partial || prior.executionStarted !== next.executionStarted ||
      prior.argsComplete !== next.argsComplete || prior.resultFailed !== next.resultFailed) {
      const changedInput = inputsMayHaveChanged || !prior || prior.args !== next.args || prior.result !== next.result ||
        prior.name !== next.name || prior.partial !== next.partial || prior.resultFailed !== next.resultFailed;
      state.snapshot = next;
      // File readers interpret saved data and finality, not the UI's expansion flag.
      if (changedInput || input.kind === 'bash') state.reader = undefined;
      if (inputsMayHaveChanged || prior?.result !== next.result) state.hasImage = undefined;
      if (state.fileChange && changedInput) {
        const reader = this.reader(owner);
        const key = reader?.kind !== 'bash' && reader?.succeeded ? reader.changeIdentity?.() : undefined;
        if (!key || key.length !== state.fileChange.key.length || key.some((value, index) => value !== state.fileChange!.key[index]))
          state.fileChange = undefined;
      }
    }
    return state.snapshot!;
  }

  selection(owner: Owner): Readonly<Pick<NonNullable<ToolCallState['input']>, 'name' | 'valid' | 'kind'>> {
    const state = this.state(owner);
    return state.input ??= this.readInput(owner);
  }

  kind(owner: Owner) { return this.selection(owner).kind; }

  hasImage(owner: Owner): boolean {
    const result = this.capture(owner).result;
    if (!result) return false;
    const state = this.state(owner);
    return state.hasImage ??= result.content?.some(part => part.type === 'image') ?? false;
  }

  fileChange(owner: Owner): FileChangeClass | null | undefined { return this.state(owner).fileChange?.value; }

  acceptFileChange(owner: Owner, reader: FileToolReader, key: readonly unknown[], value: FileChangeClass | null): void {
    const state = this.calls.peek(owner);
    if (state?.reader === reader && reader.call.id === this.fields.id(owner)) state.fileChange = { key, value };
  }

  reader(owner: Owner): ToolReader | undefined {
    const call = this.capture(owner), state = this.state(owner);
    if (state.reader === undefined) state.reader = createToolReader(call) ?? null;
    return state.reader ?? undefined;
  }
}
