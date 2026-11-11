import { captureToolCall, createToolReader, toolCardKind } from '../tool-adapters/registry.ts';
import type { ToolCallObservation } from '../tool-adapters/registry.ts';
import type { SavedToolResult, ToolCallSnapshot, ToolReader } from '../tool-adapters/contracts.ts';

export type ToolFieldAccessors<Owner> = {
  [Key in keyof ToolCallObservation]-?: (owner: Owner) => ToolCallObservation[Key];
};

export class ToolProducerPresenter<Owner extends object> {
  private readonly fields: ToolFieldAccessors<Owner>;
  private imageResults = new WeakMap<SavedToolResult, boolean>();

  constructor(fields: ToolFieldAccessors<Owner>) {
    this.fields = fields;
  }

  capture(owner: Owner) {
    return captureToolCall({
      name: this.fields.name(owner),
      id: this.fields.id(owner),
      args: this.fields.args(owner),
      result: this.fields.result(owner),
      partial: this.fields.partial(owner),
      expanded: this.fields.expanded(owner),
      executionStarted: this.fields.executionStarted(owner),
      argsComplete: this.fields.argsComplete(owner),
    });
  }

  kind(owner: Owner) {
    return this.kindFrom(this.capture(owner));
  }

  hasImage(owner: Owner): boolean {
    const result = this.fields.result(owner);
    if (!result) return false;
    const cached = this.imageResults.get(result);
    if (cached !== undefined) return cached;
    const found = result.content!.some(part => part.type === 'image');
    this.imageResults.set(result, found);
    return found;
  }

  forgetImageResult(result: SavedToolResult | undefined): void {
    if (result) this.imageResults.delete(result);
  }

  kindFrom(call: ToolCallSnapshot) {
    return call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? toolCardKind(call) : 'other';
  }

  reader(owner: Owner): ToolReader {
    return this.readerFrom(this.capture(owner));
  }

  readerFrom(call: ToolCallSnapshot): ToolReader {
    return createToolReader(call);
  }
}
