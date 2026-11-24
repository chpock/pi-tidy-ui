import { captureToolCall, createToolReader, isToolArgs, toolCards } from '../tool-adapters/registry.ts';
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
    return this.hasArgs(owner) ? this.kindForName(this.fields.name(owner)) : undefined;
  }

  kindForName(name: string) {
    return toolCards.get(name)?.kind;
  }

  hasArgs(owner: Owner): boolean {
    return isToolArgs(this.fields.args(owner));
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
    return isToolArgs(call.args) ? this.kindForName(call.name) : undefined;
  }

  reader(owner: Owner): ToolReader | undefined {
    return this.readerFrom(this.capture(owner));
  }

  readerFrom(call: ToolCallSnapshot): ToolReader | undefined {
    return createToolReader(call);
  }
}
