use occipital::{
    native_palette::{HintPaths, NativeTheme, SLOT_NAMES},
    resolver::{self, native_attributes, native_ink},
    semantic::Ink,
};
use serde::Deserialize;
use std::{collections::BTreeMap, io::Write};
use syntect::{
    highlighting::{Color, FontStyle, StyleModifier, Theme, ThemeItem},
    parsing::Scope,
};
use two_face::theme::{EmbeddedLazyThemeSet, LazyThemeSet};
#[derive(Deserialize)]
struct Inputs {
    name: String,
    defaults: Defaults,
    settings: syntect::highlighting::ThemeSettings,
    hints: BTreeMap<String, Hint>,
    #[serde(rename = "syntaxInks")]
    syntax_inks: Vec<Color>,
}
#[derive(Deserialize)]
struct Defaults {
    foreground: Color,
    background: Color,
}
#[derive(Deserialize)]
struct Hint {
    foreground: Option<Color>,
    background: Option<Color>,
    attributes: u8,
}
#[derive(Deserialize)]
struct Oracle {
    #[serde(rename = "inputSha256")]
    input_sha: String,
    themes: Vec<OracleTheme>,
}
#[derive(Deserialize)]
struct OracleTheme {
    name: String,
    palette: OraclePalette,
}
#[derive(Deserialize)]
struct OraclePalette {
    slots: BTreeMap<String, OracleStyle>,
}
#[derive(Deserialize)]
struct OracleStyle {
    foreground: Ink,
    background: Ink,
    attributes: u8,
    provenance: Provenance,
}
#[derive(Deserialize)]
struct Provenance {
    foreground: String,
    background: String,
}
fn paths() -> [Vec<Scope>; 5] {
    // Test-only fixed vocabulary authority. Production receives generated handles.
    [
        vec!["comment"],
        vec!["invalid"],
        vec!["source.diff", "markup.changed.diff"],
        vec!["source.diff", "markup.inserted.diff"],
        vec!["source.diff", "markup.deleted.diff"],
    ]
    .map(|p| p.into_iter().map(|s| Scope::new(s).unwrap()).collect())
}
fn compile(theme: &Theme) -> NativeTheme {
    let p = paths();
    NativeTheme::compile(
        theme,
        HintPaths {
            comment: &p[0],
            invalid: &p[1],
            changed: &p[2],
            inserted: &p[3],
            deleted: &p[4],
        },
    )
    .unwrap()
}
fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color { r, g, b, a: 255 }
}
fn test_theme() -> Theme {
    let mut t = Theme::default();
    t.settings.foreground = Some(rgb(230, 230, 230));
    t.settings.background = Some(rgb(40, 40, 40));
    t
}
fn item(path: &str, fg: Option<Color>, bg: Option<Color>, font: Option<FontStyle>) -> ThemeItem {
    ThemeItem {
        scope: path.parse().unwrap(),
        style: StyleModifier {
            foreground: fg,
            background: bg,
            font_style: font,
        },
    }
}
fn light(ink: &Ink) -> Option<f64> {
    let Ink::Rgb { r, g, b } = ink else {
        return None;
    };
    let srgb = |c: u8| {
        let c = f64::from(c) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    Some(0.2126 * srgb(*r) + 0.7152 * srgb(*g) + 0.0722 * srgb(*b))
}
fn contrast(a: &Ink, b: &Ink) -> Option<f64> {
    let (a, b) = (light(a)?, light(b)?);
    Some((a.max(b) + 0.05) / (a.min(b) + 0.05))
}
// Independent direct Oklab reference equations; no production conversion calls.
fn oklab(ink: &Ink) -> Option<[f64; 3]> {
    let Ink::Rgb { r, g, b } = ink else {
        return None;
    };
    let linear = |c: u8| {
        let c = f64::from(c) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let [r, g, b] = [*r, *g, *b].map(linear);
    let l = (0.4122214694707629 * r + 0.5363325372617349 * g + 0.0514459932675022 * b).cbrt();
    let m = (0.2119034958178251 * r + 0.6806995506452344 * g + 0.1073969535369405 * b).cbrt();
    let s = (0.0883024591900564 * r + 0.2817188391361215 * g + 0.6299787016738222 * b).cbrt();
    Some([
        0.210454268309314 * l + 0.793617774702305 * m - 0.0040720430116193 * s,
        1.9779985324311684 * l - 2.42859224204858 * m + 0.450593709617411 * s,
        0.0259040424655478 * l + 0.7827717124575296 * m - 0.8086757549230774 * s,
    ])
}
fn origin(ink: &Ink, source: &str) -> u8 {
    if !matches!(ink, Ink::Rgb { .. }) || source.starts_with("native-neutral:terminal-dependent") {
        2
    } else {
        u8::from(source.starts_with("derived-native:"))
    }
}
fn audit(theme: &Theme, native: &NativeTheme) -> (usize, usize, usize) {
    let p = &native.palette;
    let base = native.resolver.default_expression();
    assert_eq!(p.slots[0].background, base.background);
    let gutter = theme
        .settings
        .gutter
        .map(native_ink)
        .unwrap_or_else(|| base.background.clone());
    assert_eq!(p.slots[18].background, gutter);
    let inks: Vec<_> = std::iter::once(base.foreground.clone())
        .chain(
            theme
                .scopes
                .iter()
                .filter_map(|i| i.style.foreground)
                .map(native_ink),
        )
        .collect();
    let mut pairs = 0;
    let mut changed = 0;
    let mut symbolic = 0;
    for start in [20, 23] {
        for (index, surface) in [(start, &base.background), (start + 1, &gutter)] {
            let actual = &p.slots[index].background;
            let mut checks: Vec<_> = inks.iter().map(|c| (c, 4.5)).collect();
            if index == start + 1 {
                checks.extend([
                    (&p.slots[19].foreground, 3.0),
                    (&p.slots[start + 2].foreground, 4.5),
                ]);
            }
            if light(surface).is_none() || checks.iter().any(|(c, _)| light(c).is_none()) {
                symbolic += 1;
                assert_eq!(
                    actual, surface,
                    "unknown terminal constraint must stay neutral"
                );
            }
            changed += usize::from(actual != surface);
            if let (Some(before), Some(after)) = (oklab(surface), oklab(actual)) {
                assert!((after[0] - before[0]).abs() <= 0.025 + 0.002);
                assert!((after[1] - before[1]).hypot(after[2] - before[2]) <= 0.018 + 0.003);
            }
            for (ink, minimum) in checks {
                if let (Some(before), Some(after)) = (contrast(ink, surface), contrast(ink, actual))
                {
                    assert!(
                        after + 1e-12 >= before.min(minimum),
                        "quantized contrast regressed: {before} -> {after}"
                    );
                    pairs += 1;
                }
            }
        }
    }
    for index in [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19] {
        let style = &p.slots[index];
        if let Some(ratio) = contrast(&style.foreground, &style.background) {
            assert!(
                ratio
                    >= if [15, 16, 17].contains(&index) {
                        4.5
                    } else {
                        3.0
                    },
                "service role {} ratio {ratio}",
                SLOT_NAMES[index]
            );
        }
    }
    assert_ne!(
        (&p.slots[14].foreground, p.slots[14].attributes),
        (&p.slots[16].foreground, p.slots[16].attributes)
    );
    for style in &p.slots {
        style.validate(true, 0).unwrap();
    }
    for o in p.origins {
        assert!(o <= 31 && o & 3 < 3 && (o >> 2) & 3 < 3);
    }
    (pairs, changed, symbolic)
}
#[test]
fn all_32_live_native_definitions_match_immutable_palette_oracle() {
    use sha2::{Digest, Sha256};
    let input = include_bytes!("fixtures/native_palette_inputs.json");
    let expected_sha = "c6831b3428ef26bc7ccc1e38411c21ba82ba32858aa74ab1457ad352c0cc902f";
    assert_eq!(format!("{:x}", Sha256::digest(input)), expected_sha);
    let inputs: Vec<Inputs> = serde_json::from_slice(input).unwrap();
    let oracle_bytes = include_bytes!("fixtures/native_palette_oracle.json");
    assert_eq!(
        format!("{:x}", Sha256::digest(oracle_bytes)),
        "b85cb2afa9bb9ab927026afdfd209e8c4af10fc0e4141bccd5e23f5ac1d507c3"
    );
    let oracle: Oracle = serde_json::from_slice(oracle_bytes).unwrap();
    assert_eq!(oracle.input_sha, expected_sha);
    let themes: LazyThemeSet = two_face::theme::extra().into();
    let (mut roles, mut inks, mut concrete_pairs, mut changed, mut symbolic) = (0, 0, 0, 0, 0);
    let mut counters = occipital::native_palette::Counters::default();
    for name in EmbeddedLazyThemeSet::theme_names() {
        let theme = themes.get(name.as_name()).unwrap();
        let input = inputs.iter().find(|t| t.name == name.as_name()).unwrap();
        assert_eq!(
            input.settings, theme.settings,
            "fixture inputs must match actual ThemeSettings"
        );
        let defaults = syntect::highlighting::Highlighter::new(theme).get_default();
        assert_eq!(input.defaults.foreground, defaults.foreground);
        assert_eq!(input.defaults.background, defaults.background);
        let native = compile(theme);
        // Reference hints are test inputs only, never fed into production derivation.
        let probes = paths();
        let mut cursor = native.resolver.cursor(2).unwrap();
        for (key, path) in ["comment", "invalid", "changed", "inserted", "deleted"]
            .iter()
            .zip(&probes)
        {
            let hint = &input.hints[*key];
            let value = cursor.resolve(path).unwrap();
            assert_eq!(
                hint.attributes,
                FontStyle::from_bits_truncate(hint.attributes).bits()
            );
            assert_eq!(
                native_attributes(FontStyle::from_bits_truncate(hint.attributes)),
                value.expression.attributes
            );
            if let Some(color) = hint.foreground {
                assert_eq!(native_ink(color), value.expression.foreground);
            }
            if let Some(color) = hint.background {
                assert_eq!(native_ink(color), value.expression.background);
            }
        }
        let expected = &oracle
            .themes
            .iter()
            .find(|t| t.name == name.as_name())
            .unwrap()
            .palette;
        for (index, role) in SLOT_NAMES.iter().enumerate() {
            let actual = &native.palette.slots[index];
            let reference = &expected.slots[*role];
            assert_eq!(
                actual.foreground, reference.foreground,
                "{name:?}/{role}: foreground"
            );
            assert_eq!(
                actual.background, reference.background,
                "{name:?}/{role}: background"
            );
            assert_eq!(
                actual.attributes,
                native_attributes(FontStyle::from_bits_truncate(reference.attributes)),
                "{name:?}/{role}: font"
            );
            let expected_origin = origin(&reference.foreground, &reference.provenance.foreground)
                | (origin(&reference.background, &reference.provenance.background) << 2)
                | (u8::from(index == 16) << 4);
            assert_eq!(
                native.palette.origins[index], expected_origin,
                "{name:?}/{role}: provenance"
            );
            roles += 1;
        }
        let mut actual_inks = vec![defaults.foreground];
        for item in &theme.scopes {
            if let Some(fg) = item.style.foreground {
                if !actual_inks.contains(&fg) {
                    actual_inks.push(fg);
                }
            }
        }
        assert_eq!(actual_inks, input.syntax_inks);
        assert_eq!(
            native.palette.counters.native_ink_entries,
            actual_inks.len()
        );
        inks += actual_inks.len();
        let (a, b, c) = audit(theme, &native);
        concrete_pairs += a;
        changed += b;
        symbolic += c;
        let c = native.palette.counters;
        counters.palettes += c.palettes;
        counters.native_ink_entries += c.native_ink_entries;
        counters.candidate_visits += c.candidate_visits;
        counters.tint_requests += c.tint_requests;
        counters.paint_candidates += c.paint_candidates;
        counters.quantized_ink_checks += c.quantized_ink_checks;
        counters.gamut_bisections += c.gamut_bisections;
    }
    assert_eq!((roles, inks), (832, 614));
    assert_eq!((changed, symbolic), (90, 12));
    writeln!(std::io::stdout(), "palette parity: 32 themes, {roles} roles, {inks} inks, {concrete_pairs} independent concrete contrast pairs, {changed} tinted / {symbolic} symbolic surfaces; counters={counters:?}").unwrap();
}
#[test]
fn empty_source_defaults_symbolic_colors_and_global_rules_never_invent_hints() {
    let empty = Theme::default();
    let native = compile(&empty);
    assert_eq!(native.palette.slots.len(), 26);
    audit(&empty, &native);
    let mut theme = test_theme();
    theme.scopes.push(item(
        "",
        Some(rgb(0, 255, 0)),
        Some(rgb(20, 60, 20)),
        Some(FontStyle::BOLD | FontStyle::ITALIC),
    ));
    let global = compile(&theme);
    assert_eq!(
        global.palette.slots[20].background,
        native_ink(theme.settings.background.unwrap())
    );
    assert_eq!(
        global.palette.slots[22].attributes, 0,
        "global font is not an authored inserted hint"
    );
    assert_eq!(
        global.palette.slots[25].attributes, 0,
        "global font is not an authored deleted hint"
    );
    for field in [0, 1, 2] {
        for a in [0, 1] {
            let mut theme = test_theme();
            let c = Color {
                r: 7,
                g: 0,
                b: 0,
                a,
            };
            match field {
                0 => theme.settings.foreground = Some(c),
                1 => theme.settings.background = Some(c),
                _ => theme.settings.gutter = Some(c),
            }
            theme
                .scopes
                .push(item("markup.inserted", Some(rgb(0, 255, 0)), None, None));
            let native = compile(&theme);
            let (_, _, symbolic) = audit(&theme, &native);
            assert_eq!(symbolic, if field == 2 { 2 } else { 4 });
            assert!(native.palette.origins[20..].iter().any(|o| o & 10 != 0));
        }
    }
}
#[test]
fn full_native_inks_include_the_tenth_contrast_constraint() {
    let mut t = test_theme();
    t.settings.foreground = Some(rgb(255, 255, 255));
    t.scopes
        .push(item("markup.inserted", Some(rgb(0, 255, 0)), None, None));
    let unconstrained = compile(&t);
    let tenth = rgb(60, 60, 60);
    assert!(
        contrast(
            &native_ink(tenth),
            &unconstrained.palette.slots[20].background
        )
        .unwrap()
            < contrast(
                &native_ink(tenth),
                &unconstrained.palette.slots[0].background
            )
            .unwrap()
    );
    // Distinct foreground declarations, not an artificial nine-role subset.
    for c in 240..249 {
        t.scopes
            .push(item("unused", Some(rgb(c, c, c)), None, None));
    }
    t.scopes.push(item("unused.tenth", Some(tenth), None, None));
    let native = compile(&t);
    assert!(native.palette.counters.native_ink_entries > 10);
    audit(&t, &native);
}
#[test]
fn saturated_hints_opposite_gutters_and_native_font_clears() {
    for color in [
        rgb(255, 0, 0),
        rgb(0, 255, 0),
        rgb(0, 0, 255),
        rgb(255, 0, 255),
    ] {
        let mut t = test_theme();
        t.scopes.push(item(
            "markup.inserted, markup.deleted",
            Some(color),
            Some(color),
            None,
        ));
        let native = compile(&t);
        assert_eq!(audit(&t, &native).1, 4);
    }
    let mut t = test_theme();
    t.settings.gutter = Some(rgb(240, 240, 240));
    t.scopes.push(item(
        "invalid",
        None,
        None,
        Some(FontStyle::ITALIC | FontStyle::UNDERLINE),
    ));
    let native = compile(&t);
    audit(&t, &native);
    assert_ne!(
        native.palette.slots[13].foreground,
        native.palette.slots[19].foreground
    );
    assert_eq!(native.palette.slots[15].attributes, 6);
    assert_eq!(native.palette.slots[16].attributes, 7);
    assert_eq!(
        native.palette.slots[15].attribute_mask,
        resolver::ALL_ATTRIBUTES
    );
}
