import { selectToolPresentationIntent, type ToolPresentationIntent } from './tool-intents.ts';
import type { ToolPresentationPolicy } from './tool-policy.ts';

export interface ToolNativeVisibility<Owner> {
  fileRenderer(owner: Owner): boolean;
  readRenderer(owner: Owner): boolean;
  selfShell(owner: Owner): boolean;
  deferredFilePair(owner: Owner): boolean;
  stockEditShell(owner: Owner): boolean;
  visible(owner: Owner, width: number): boolean;
}

export class ToolRoutingPresenter<Owner extends object> {
  private readonly policy: ToolPresentationPolicy<Owner>;
  private readonly native: ToolNativeVisibility<Owner>;

  constructor(policy: ToolPresentationPolicy<Owner>, native: ToolNativeVisibility<Owner>) {
    this.policy = policy;
    this.native = native;
  }

  compact(owner: Owner, width: number): boolean {
    if (!this.policy.compactIntent(owner, width)) return false;
    if (this.readRenderer(owner)) return true;
    return this.visible(owner, width);
  }

  bash(owner: Owner, width: number): boolean {
    return this.policy.bashIntent(owner, width) && this.visible(owner, width);
  }

  file(owner: Owner, width: number): boolean {
    return this.fileIntent(owner, width) === 'file';
  }

  fileIntent(owner: Owner, width: number): ToolPresentationIntent {
    return this.policy.fileIntent(owner, width);
  }

  fileSuppressed(owner: Owner, width: number): boolean {
    return this.fileIntent(owner, width) === 'suppressed';
  }

  fileVisible(owner: Owner, width: number): boolean {
    return this.readRenderer(owner) || this.visible(owner, width);
  }

  readSyntaxVisible(owner: Owner, width: number | undefined, observedVisibility?: boolean): boolean {
    if (this.readRenderer(owner)) return true;
    return observedVisibility ?? (width !== undefined && width > 0 && this.visible(owner, width));
  }

  summaryIntent(owner: Owner, width: number): ToolPresentationIntent {
    if (!this.policy.eligible(owner)) return 'native';
    const intent = selectToolPresentationIntent(width, false, false, true);
    if (intent !== 'compact') return intent;
    if (this.visible(owner, width)) return intent;
    return 'suppressed';
  }

  private visible(owner: Owner, width: number): boolean {
    if (!this.native.selfShell(owner)) return true;
    if (this.policy.fileTool(owner) && this.native.deferredFilePair(owner)) return true;
    if (this.native.stockEditShell(owner)) return true;
    return this.native.visible(owner, width);
  }

  fileRenderer(owner: Owner): boolean {
    return this.policy.fileTool(owner) && this.native.fileRenderer(owner);
  }

  readRenderer(owner: Owner): boolean {
    return this.policy.kind(owner) === 'read' && this.native.readRenderer(owner);
  }
}
