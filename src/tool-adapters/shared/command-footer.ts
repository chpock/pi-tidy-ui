export interface CommandFailure {
  readonly error: boolean;
  readonly exitCode?: number;
  readonly toolFailed: boolean;
  readonly phase?: 'formation' | 'execution';
  readonly timedOut?: boolean;
}

export function commandFooter(input: CommandFailure): string {
  const fields = input.error ? [input.exitCode !== undefined && input.exitCode !== 0 ? `exit code: ${input.exitCode}` : '',
    input.timedOut ? 'error: command timed out' : input.toolFailed
      ? input.phase === 'formation' ? 'error: incomplete tool call'
        : input.phase === 'execution' ? 'error: execution failed' : 'error: tool call failed' : ''].filter(Boolean) : [];
  return fields.length ? `[${fields.join('; ')}]` : '';
}
