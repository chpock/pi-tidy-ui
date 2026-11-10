import '../../../fixtures/test-guard.mjs';
import test from 'node:test';
import { prepareSyntaxNative, requiredSharedHost } from '../../../fixtures/syntax-cli-support.mjs';
import { sharedSyntaxHost } from '../../../fixtures/shared-syntax-host.mjs';
import { assertPreviewShebangReplay } from '../../../fixtures/file-preview-shebang-replay.mjs';

const { binary, fixture, descriptor } = await prepareSyntaxNative();
for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: shared ${mode} preview preserves original shebang provenance on real replay`,
  { timeout: 60000 }, async () => {
    const shared = await sharedSyntaxHost(requiredSharedHost(), binary);
    try { await assertPreviewShebangReplay({ mode, fixture, descriptor, shared }); }
    finally { await shared.close(); }
  });
