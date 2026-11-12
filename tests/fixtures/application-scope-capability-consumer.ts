import type { PreferenceScope } from '../../src/application/preferences.ts';
import { ApplicationScope } from '../../src/application/scope.ts';

// Compiled but never invoked: application code borrows currentness, not its controller.
export function consumeApplicationScope() {
  const owner = new ApplicationScope();
  const captured = owner.beginSession(), scope: PreferenceScope = owner.scope(captured);
  owner.isGeneration(captured); scope.current(); owner.retire();
  // @ts-expect-error a captured generation is not a writable lifecycle authority
  owner.generation = 3;
  // @ts-expect-error the abort controller is private to its application scope
  owner.abort.abort();
  // @ts-expect-error retirement always advances the actual current generation
  owner.retire(captured);
  // @ts-expect-error scope construction is not a context/service binding
  owner.beginSession({ ui: {} });
  // @ts-expect-error the existing preference-scope signal is a readonly borrow
  scope.signal = new AbortController().signal;
  // @ts-expect-error an application scope accepts no owner bag
  new ApplicationScope({ preferences: {} });
}
