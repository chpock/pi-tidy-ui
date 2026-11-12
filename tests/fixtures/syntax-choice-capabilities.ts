import type { SyntaxClientOptions } from '../../src/application/syntax-client.ts';
import type { SyntaxRuntimeOptions } from '../../src/application/syntax-runtime.ts';

/** Compile-only consumers must receive choices, not settings publication authority. */
export function syntaxChoiceCapabilities(client: SyntaxClientOptions, runtime: SyntaxRuntimeOptions): void {
  // @ts-expect-error Settings publication belongs to the application preference owner.
  void client.settings;
  // @ts-expect-error Runtime syntax options must not expose the persistence capability either.
  void runtime.settings;
}
