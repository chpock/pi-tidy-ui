// Complete newline-terminated records only: a startup-truncated PID must never become kill(0).
export function parseJobGroup(record) {
  if (!/^[1-9]\d*\n$/.test(record)) throw new Error('Incomplete or invalid owned job-group record');
  const pid = Number(record);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid owned job group');
  return pid;
}
