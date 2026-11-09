export type ThemeVariant = 'dark' | 'light';
export type ThemePreference = { kind: 'pi'; variant: ThemeVariant } | { kind: 'theme'; id: string; variant: ThemeVariant };

export function copyThemePreference(choice: ThemePreference): ThemePreference {
  return choice.kind === 'pi' ? { kind: 'pi', variant: choice.variant }
    : { kind: 'theme', id: choice.id, variant: choice.variant };
}

export function sameThemePreference(left: ThemePreference, right: ThemePreference): boolean {
  return left.kind === right.kind && left.variant === right.variant &&
    (left.kind === 'pi' || right.kind === 'theme' && left.id === right.id);
}
