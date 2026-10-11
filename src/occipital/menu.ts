import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SelectList, truncateToWidth } from '@earendil-works/pi-tui';
import type { SyntaxTheme } from '../settings.ts';
import { PROTOCOL_VERSION, type ProfileDescription } from './protocol.ts';
import type { ProviderSnapshot } from './provider.ts';

export type SyntaxMenuOutcome = { ok: true } | { ok: false; message: string };

export interface SyntaxMenuSnapshot {
  enabled: boolean;
  provider: ProviderSnapshot;
  standaloneVersion: string;
  selected: SyntaxTheme;
  effective?: ProfileDescription;
  /** Owner-supplied bounded, public-safe issue; never a raw transport/settings error. */
  lastIssue?: string;
}

/** Cached metadata only. The owner guards its own asynchronous mutations against
 * retirement; the menu's current callback cannot cancel work already delegated.
 * Outcome messages and declared versions must be bounded and public-safe. */
export interface SyntaxMenuOwner {
  /** Read cached, validated metadata only; no describe, refresh or startup. */
  snapshot(): SyntaxMenuSnapshot;
  /** May apply the live selection even when persistence returns an error. */
  selectTheme(choice: SyntaxTheme): Promise<SyntaxMenuOutcome>;
  refreshThemes(): Promise<SyntaxMenuOutcome>;
  setEnabled(enabled: boolean): Promise<void>;
}

function themeLabels(snapshot: SyntaxMenuSnapshot): string {
  const choice = snapshot.selected;
  const selected = choice.kind === 'pi' ? 'Pi palette' :
    `${snapshot.provider.description?.profiles.find(profile => profile.id === choice.id)?.label ?? 'Theme'} [${JSON.stringify(choice.id)}]`;
  const effective = !snapshot.effective ? 'Unavailable' : snapshot.effective.id === 'pi' ? 'Pi palette' :
    `${snapshot.effective.label} [${JSON.stringify(snapshot.effective.id)}]`;
  return `Selected: ${selected}\nEffective: ${effective}`;
}

function themesUnavailable(snapshot: SyntaxMenuSnapshot): string | undefined {
  if (!snapshot.enabled) return 'Syntax highlighting is disabled for this session.';
  if (snapshot.provider.availability !== 'ready') {
    return `Native themes are unavailable: provider is ${snapshot.provider.availability}.`;
  }
  if (!snapshot.provider.description) return 'Native themes are unavailable: no cached catalogue.';
  return undefined;
}

function serviceStatus(snapshot: SyntaxMenuSnapshot): string {
  const provider = snapshot.provider;
  return [
    `Syntax highlighting: ${snapshot.enabled ? 'enabled' : 'disabled'} for this session`,
    `Service: ${provider.availability} (${provider.reason})`,
    `Provider: ${provider.kind ?? 'none'}`,
    `Daemon version: ${provider.description?.backend_version ?? 'unavailable'}`,
    `Protocol: ${provider.description ? PROTOCOL_VERSION : 'unavailable'}`,
    `Declared standalone version: ${snapshot.standaloneVersion}`,
    themeLabels(snapshot),
    `Last issue: ${snapshot.lastIssue ?? 'none'}`,
  ].join('\n');
}

/** Public native-dialog flow only. current must capture this invocation's owner
 * generation and be false after off/master-off, replacement, reload or disposal. */
export async function openSyntaxMenu(
  ctx: Pick<ExtensionContext, 'mode' | 'hasUI' | 'ui'>,
  owner: SyntaxMenuOwner,
  current: () => boolean,
): Promise<void> {
  const notify = (message: string, type: 'info' | 'error') => {
    if (current()) ctx.ui.notify(message, type);
  };
  if (!current()) return;
  if (ctx.mode !== 'tui' || !ctx.hasUI) {
    notify('Syntax menu is available only in terminal mode with UI.', 'error');
    return;
  }

  while (current()) {
    const snapshot = owner.snapshot();
    const enabled = snapshot.enabled;
    const toggle = enabled ? 'Disable for this session' : 'Enable for this session';
    let action: string | undefined;
    if (!current()) return;
    try {
      action = await ctx.ui.select('Syntax highlighting', ['Theme', 'Reload themes', 'Service status', toggle, 'Close']);
    } catch {
      if (!current()) return;
      notify('Syntax menu could not be opened.', 'error');
      return;
    }
    if (!current()) return;
    if (action === undefined || action === 'Close') return;

    let operation: () => Promise<SyntaxMenuOutcome | void>;
    let success: string;
    let failure: string;
    if (action === 'Theme') {
      const themes = owner.snapshot();
      const unavailable = themesUnavailable(themes);
      const choices: { label: string; choice: SyntaxTheme }[] = [{ label: '1. Pi palette', choice: { kind: 'pi' } }];
      if (!unavailable) {
        for (const profile of themes.provider.description!.profiles) {
          if (profile.id === 'pi') continue;
          // Native select returns strings, not IDs. A distinct ordinal avoids all
          // duplicate labels (including labels that imitate another choice/Back).
          choices.push({ label: `${choices.length + 1}. ${profile.label} [${JSON.stringify(profile.id)}]`,
            choice: { kind: 'occipital', id: profile.id } });
        }
      }
      let picked: string | undefined;
      if (!current()) return;
      try {
        picked = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
          const headers = ['Syntax theme', ...themeLabels(themes).split('\n'), ...(unavailable ? [unavailable] : [])];
          const items = [...choices.map((choice, index) => ({ value: String(index), label: choice.label })),
            { value: 'back', label: 'Back' }];
          let closed = false;
          let list: SelectList | undefined;
          let capacity = 0;
          const finish = (value: string | undefined) => {
            if (closed) return;
            closed = true;
            done(current() ? value : undefined);
          };
          const layout = () => {
            const rows = Math.max(1, tui.terminal.rows);
            // Reserve one selected row and SelectList's own scroll-indicator row.
            // At one terminal row the indicator, never the selected row, is omitted.
            const headerRows = Math.min(headers.length, Math.max(0, rows - 2));
            const visible = Math.max(1, rows - headerRows - 1);
            if (!list || capacity !== visible) {
              const selected = list?.getSelectedItem()?.value;
              list = new SelectList(items, visible, {
                selectedPrefix: text => theme.fg('accent', text),
                selectedText: text => theme.fg('accent', text),
                description: text => theme.fg('muted', text),
                scrollInfo: text => theme.fg('dim', text),
                noMatch: text => theme.fg('muted', text),
              });
              if (selected !== undefined) list.setSelectedIndex(items.findIndex(item => item.value === selected));
              list.onSelect = item => finish(choices[Number(item.value)]?.label);
              list.onCancel = () => finish(undefined);
              capacity = visible;
            }
            return { rows, headerRows, list };
          };
          if (!current()) finish(undefined);
          return {
            render(width) {
              if (closed) return [];
              const { rows, headerRows, list } = layout();
              return [...headers.slice(0, headerRows).map(text => theme.fg('muted', text)),
                ...list.render(Math.max(4, width)).slice(0, rows - headerRows)]
                .map(line => truncateToWidth(line, Math.max(1, width)));
            },
            handleInput(data) {
              if (closed) return;
              if (!current() || keybindings.matches(data, 'tui.select.cancel')) { finish(undefined); return; }
              layout().list.handleInput(data);
              if (!closed) tui.requestRender();
            },
            invalidate() { list?.invalidate(); },
            dispose() {
              closed = true;
              if (list) { list.onSelect = undefined; list.onCancel = undefined; }
              list = undefined;
            },
          };
        }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0, anchor: 'top-left' } });
      } catch {
        if (!current()) return;
        notify('Syntax theme picker could not be opened.', 'error');
        continue;
      }
      if (!current()) return;
      if (picked === undefined || picked === 'Back') continue;
      const choice = choices.find(choice => choice.label === picked)?.choice;
      if (!choice) continue;
      operation = () => owner.selectTheme(choice);
      success = 'Syntax theme selected.';
      failure = 'Syntax theme selection could not be saved.';
    } else if (action === 'Reload themes') {
      const unavailable = themesUnavailable(owner.snapshot());
      if (unavailable) { notify(unavailable, 'error'); continue; }
      operation = () => owner.refreshThemes();
      success = 'Syntax themes reloaded.';
      failure = 'Syntax themes could not be reloaded.';
    } else if (action === 'Service status') {
      notify(serviceStatus(owner.snapshot()), 'info');
      continue;
    } else if (action === toggle) {
      operation = () => owner.setEnabled(!enabled);
      success = `Syntax highlighting ${enabled ? 'disabled' : 'enabled'} for this session.`;
      failure = 'Syntax highlighting session setting could not be changed.';
    } else {
      return;
    }

    if (!current()) return;
    let outcome: SyntaxMenuOutcome | void;
    try {
      outcome = await operation();
    } catch {
      if (!current()) return;
      notify(failure, 'error');
      continue;
    }
    if (!current()) return;
    if (outcome && !outcome.ok) notify(outcome.message, 'error');
    else notify(success, 'info');
  }
}
