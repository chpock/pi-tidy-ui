import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

type NotificationLevel = 'error' | 'warning' | 'info';

export function notify(ui: Pick<ExtensionContext['ui'], 'notify'> | undefined, message: string, level: NotificationLevel): void {
  ui?.notify(`[pi-tidy-ui] ${message}`, level);
}
