import '../../../fixtures/test-guard.mjs';
import test from 'node:test';
import { prepareSyntaxNative } from '../../../fixtures/syntax-cli-support.mjs';
import { assertPreviewShebangReplay } from '../../../fixtures/file-preview-shebang-replay.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: owned ${mode} preview preserves original shebang provenance on real replay`,
  { timeout: 60000 }, () => assertPreviewShebangReplay({ mode, fixture, descriptor }));
