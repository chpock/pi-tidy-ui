import { setTimeout, clearTimeout } from 'node:timers';

/** A synthetic host has no TTY/socket holding the loop while production timers are unref'd. */
export async function awaitFixture<T>(promise: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('fixture activity deadline')), milliseconds);
  });
  try { return await Promise.race([promise, deadline]); }
  finally { if (timer) clearTimeout(timer); }
}
