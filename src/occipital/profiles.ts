import type { SyntaxTheme } from '../settings.ts';
import type { ProfileDescription } from './protocol.ts';

export interface ResolvedTheme {
  readonly selected: SyntaxTheme;
  readonly effective?: ProfileDescription;
  readonly missing: boolean;
}

/** Resolve a preference against a protocol-validated catalogue; undefined means no usable provider. */
export function resolveTheme(selected: SyntaxTheme, profiles: readonly ProfileDescription[] | undefined): ResolvedTheme {
  const choice: SyntaxTheme = selected.kind === 'pi' ? { kind: 'pi' } : { kind: 'occipital', id: selected.id };
  if (profiles === undefined) return { selected: choice, effective: undefined, missing: false };

  const preferred = profiles.find(profile => profile.id === (choice.kind === 'pi' ? 'pi' : choice.id));
  // The protocol boundary guarantees the required pi profile in every ready catalogue.
  const effective = preferred ?? profiles.find(profile => profile.id === 'pi')!;
  return {
    selected: choice,
    effective: { id: effective.id, label: effective.label, fingerprint: effective.fingerprint },
    missing: preferred === undefined,
  };
}
