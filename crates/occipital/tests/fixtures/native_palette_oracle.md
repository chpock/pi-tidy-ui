# Native palette test authority

These fixtures are test-only, not runtime tables or palette inputs.

- `native_palette_inputs.json`: unchanged E2 normalized inputs, SHA-256 `c6831b3428ef26bc7ccc1e38411c21ba82ba32858aa74ab1457ad352c0cc902f`. Tests compare these settings/defaults/hints/614 declared inks to the actual bundled Syntect definitions; production receives `Theme` directly.
- `native_palette_oracle.json`: name/palette projection of the frozen Rust E2 output, independently proved exactly equal to the immutable JavaScript reference (32 themes, 832 roles). Original complete output SHA-256 `5b1d060a895f65a16667b6d5c8f2308d5c3ccc8709fb72a8ef3921db7f60fa78`; this lossless palette-only projection SHA-256 `b85cb2afa9bb9ab927026afdfd209e8c4af10fc0e4141bccd5e23f5ac1d507c3`. No test needs historical examples, another worktree, an installed Pi or ignored artifact paths.

The oracle records Syntect font bits. Tests explicitly translate them to v3 bold1/italic2/underline4/faint8 before comparison. All quantized colors must match exactly; no color tolerance is applied. Compact origin bytes retain theme/default vs derived vs terminal-dependent color authority; error-frame UI bold sets the font derivation bit. Neutral literal surfaces returned unchanged by the constraint search retain their theme/default authority. Terminal-dependent constraints are marked even if the retained neutral surface itself is RGB.

Independent test contrast checks use the actual live theme foreground declarations, not the production kernel's constraint list, and allow only the established `1e-12` arithmetic comparison tolerance. Authored low-contrast syntax is not repaired or recolored.
