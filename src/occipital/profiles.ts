import type { SyntaxTheme } from '../settings.ts';
import type { ProfileDescription } from './protocol.ts';
import { createPiRuleDefinition } from '../syntax/pi-rules.ts';
import { fingerprintRules } from './style-rules.ts';

// A local input to the common resolver, never an advertised native profile.
const pi = Object.freeze({ id: 'pi', label: 'Pi palette', fingerprint: fingerprintRules(createPiRuleDefinition()) });

export interface ResolvedTheme {
  readonly selected: SyntaxTheme;
  readonly effective?: ProfileDescription;
  readonly missing: boolean;
}

/** Native choices require a validated catalogue; local Pi rules do not require a provider. */
export function resolveTheme(selected: SyntaxTheme, profiles: readonly ProfileDescription[] | undefined): ResolvedTheme {
  const choice: SyntaxTheme = selected.kind === 'pi' ? { kind: 'pi' } : { kind: 'occipital', id: selected.id };
  if (choice.kind === 'pi') return { selected: choice, effective: { ...pi }, missing: false };
  if (profiles === undefined) return { selected: choice, effective: undefined, missing: false };

  const preferred = profiles.find(profile => profile.id === choice.id);
  const effective = preferred ?? pi;
  return {
    selected: choice,
    effective: { id: effective.id, label: effective.label, fingerprint: effective.fingerprint },
    missing: preferred === undefined,
  };
}
