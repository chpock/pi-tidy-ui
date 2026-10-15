export async function runCleanupSteps(...steps) {
  const errors = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Terminal fixture cleanup failed');
}

export function closeTerminals(terminals) {
  return runCleanupSteps(...Array.from(terminals).flatMap(terminal => [() => terminal.close(), () => terminal.dispose()]));
}

export async function closeTerminalsInParallel(terminals) {
  const results = await Promise.allSettled(terminals.map(terminal => terminal.close()));
  return runCleanupSteps(
    ...results.filter(result => result.status === 'rejected').map(result => () => { throw result.reason; }),
    ...terminals.map(terminal => () => terminal.dispose()),
  );
}
