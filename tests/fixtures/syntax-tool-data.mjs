import assert from 'node:assert/strict';

// Independent shell executions can report different durations. Preserve every
// other tool field, and never accept malformed timing or change the original.
export const syntaxToolData = dump => dump.tools.map(({ name, args, content, details, structuredContent, isError, argsComplete, executionStarted, partial }) => {
  if (name === 'bash' && structuredContent && Object.hasOwn(structuredContent, 'wall_time_seconds')) {
    const { wall_time_seconds, ...rest } = structuredContent;
    assert.equal(typeof wall_time_seconds, 'number');
    assert.ok(Number.isFinite(wall_time_seconds) && wall_time_seconds >= 0);
    structuredContent = rest;
  }
  return { name, args, content, details, structuredContent, isError, argsComplete, executionStarted, partial };
});
