const number = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${number}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function parseVersion(value: unknown): { prerelease: boolean } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = semver.exec(value);
  if (match?.[0] === value) return { prerelease: !!match[1] };
  return undefined;
}
