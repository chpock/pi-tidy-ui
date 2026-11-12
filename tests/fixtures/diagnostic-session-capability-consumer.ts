import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SessionDiagnostics } from '../../src/application/diagnostic-session.ts';
import type { DiagnosticSink } from '../../src/diagnostics.ts';
import type { RuntimeHealthSnapshot } from '../../src/runtime-health.ts';
import type { SessionLogging } from '../../src/session-logging.ts';

function consumer(binding: SessionDiagnostics, ctx: ExtensionContext): void {
  const sink: DiagnosticSink | undefined = binding.sink;
  const journal: SessionLogging | undefined = binding.journal;
  const health: RuntimeHealthSnapshot | undefined = binding.healthSnapshot();
  binding.refreshJournalContext(ctx);
  const close: Promise<void> | undefined = binding.closeJournal('reload');
  void sink; void journal; void health; void close;
  // @ts-expect-error The diagnostic sink is selected by session identity, not caller assignment.
  binding.sink = undefined;
  // @ts-expect-error Journal reference release belongs to the binding's explicit lifecycle.
  binding.journal = undefined;
  // @ts-expect-error Observation does not own source disposal.
  binding.stopSyntax();
  // @ts-expect-error Observation does not own native hooks.
  binding.controller.restore();
  // @ts-expect-error Snapshot aggregation remains in application composition.
  binding.logSnapshot();
}
function configuration(): ConstructorParameters<typeof SessionDiagnostics>[0] {
  // @ts-expect-error Diagnostic construction accepts journal configuration, not an application owner bag.
  return { syntax: {}, preferences: {}, controller: {} };
}
void consumer; void configuration;
