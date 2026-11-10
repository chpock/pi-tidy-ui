import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ExtensionSettings } from '../settings.ts';
import { notify } from '../notifications.ts';
import { createNativeAcquisition } from '../occipital/acquisition.ts';
import { NATIVE_RELEASE, type NativeReleaseDeclaration } from '../occipital/release.ts';
import type { DiagnosticSink } from '../diagnostics.ts';
import type { SyntaxRuntimeOptions } from './syntax-runtime.ts';

/** Native filesystem/network work starts only after eligible presentation attachment. */
export function createSyntaxOptions(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager' | 'ui'>,
  release: NativeReleaseDeclaration | undefined = NATIVE_RELEASE, diagnostic?: DiagnosticSink): SyntaxRuntimeOptions {
  const agentDir = getAgentDir(), cwd = ctx.cwd;
  const identity = { harness: 'pi', session: ctx.sessionManager.getSessionId(), project_root: cwd };
  const native = createNativeAcquisition({ agentDir, cwd, identity, release, diagnostic,
    createOnMissing: () => missingLocalWarning(new WeakRef(ctx.ui)) });
  return {
    diagnostic,
    standaloneVersion: native.standaloneVersion,
    settings: new ExtensionSettings({ agentDir }),
    provider: native.provider,
  };
}

function missingLocalWarning(ui: WeakRef<ExtensionContext['ui']>): () => void {
  let warned = false;
  return () => {
    if (warned) return;
    const current = ui.deref();
    if (!current) return;
    warned = true;
    notify(current, 'Local Occipital build not found next to this extension; using fallback highlighting without Occipital.', 'warning');
  };
}
