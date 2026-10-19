//! Source-independent full-native card palette, derived once per selected definition.
//! No Pi input, source text, JSON maps, theme catalogue scan or terminal RGB guess.
use crate::{
    resolver::{self, Resolver},
    semantic::{Expression, Ink, CARD_SLOTS},
};
use syntect::{
    highlighting::{Color, Theme, ThemeSettings},
    parsing::Scope,
};

const LIGHTNESS: f64 = 0.025;
const CHROMA: f64 = 0.018;
pub const SLOT_NAMES: [&str; CARD_SLOTS] = [
    "panel",
    "plain",
    "code",
    "output",
    "empty",
    "padding",
    "service",
    "muted",
    "footer",
    "reminder",
    "overflow",
    "diagnostic",
    "title",
    "prompt",
    "frame",
    "error",
    "errorFrame",
    "warning",
    "gutter",
    "numbers",
    "addedCode",
    "addedGutter",
    "addedSign",
    "removedCode",
    "removedGutter",
    "removedSign",
];
/// Fixed semantic probe paths resolved by the caller's generated trusted vocabulary.
/// Order: comment, invalid, changed, inserted, deleted. No text is interned here.
pub struct HintPaths<'a> {
    pub comment: &'a [Scope],
    pub invalid: &'a [Scope],
    pub changed: &'a [Scope],
    pub inserted: &'a [Scope],
    pub deleted: &'a [Scope],
}
#[derive(Clone, Copy)]
enum Origin {
    Theme = 0,
    Derived = 1,
    TerminalDependent = 2,
}
#[derive(Clone)]
struct ColorRef {
    color: Ink,
    origin: Origin,
}
impl ColorRef {
    fn native(color: Color) -> Self {
        Self {
            color: resolver::native_ink(color),
            origin: Origin::Theme,
        }
    }
    fn encoded_origin(&self) -> u8 {
        match self.color {
            Ink::Rgb { .. } => self.origin as u8,
            _ => Origin::TerminalDependent as u8,
        }
    }
}
#[derive(Default)]
struct Hint {
    foreground: Option<ColorRef>,
    background: Option<ColorRef>,
    attributes: u8,
}
#[derive(Debug, Default, Clone, Copy)]
pub struct Counters {
    pub palettes: usize,
    pub native_ink_entries: usize,
    pub candidate_visits: usize,
    pub tint_requests: usize,
    pub paint_candidates: usize,
    pub quantized_ink_checks: usize,
    pub gamut_bisections: usize,
}
pub struct Palette {
    pub slots: [Expression; CARD_SLOTS],
    pub origins: [u8; CARD_SLOTS],
    pub counters: Counters,
}
pub struct NativeTheme {
    pub resolver: Resolver,
    pub palette: Palette,
}
#[derive(Clone, Copy, Debug)]
pub struct Allocation {
    pub definition_bytes: usize,
    pub scratch_bytes: usize,
}
impl NativeTheme {
    /// Structural peak allowance for all controlled temporaries, not asset heaps/RSS.
    pub fn allocation(theme: &Theme, depth: usize) -> Result<Allocation, resolver::Error> {
        use std::mem::size_of;
        let inks = theme
            .scopes
            .iter()
            .filter(|item| item.style.foreground.is_some())
            .count()
            .checked_add(1)
            .ok_or(resolver::Error::WorkspaceOverflow)?;
        let candidates = inks
            .checked_add(2 + 10 + settings(&theme.settings).iter().flatten().count())
            .ok_or(resolver::Error::WorkspaceOverflow)?;
        let constraints = inks
            .checked_add(1)
            .ok_or(resolver::Error::WorkspaceOverflow)?;
        let gutter = constraints
            .checked_add(2)
            .ok_or(resolver::Error::WorkspaceOverflow)?;
        let mut scratch = resolver::Cursor::workspace_bytes(depth)?;
        for (count, width) in [
            (5, size_of::<Hint>()),
            (inks, size_of::<Color>()),
            (inks, size_of::<Ink>()),
            (candidates, size_of::<ColorRef>()),
            (candidates, size_of::<(ColorRef, Option<f64>)>()),
            (constraints, size_of::<(Ink, f64)>()),
            (gutter, size_of::<(Ink, f64)>()),
            (gutter, size_of::<(f64, f64)>()),
        ] {
            scratch = scratch
                .checked_add(
                    count
                        .checked_mul(width)
                        .ok_or(resolver::Error::WorkspaceOverflow)?,
                )
                .ok_or(resolver::Error::WorkspaceOverflow)?;
        }
        Ok(Allocation {
            definition_bytes: Resolver::native_bytes(theme)?,
            scratch_bytes: scratch,
        })
    }
    pub fn compile(theme: &Theme, paths: HintPaths<'_>) -> Result<Self, resolver::Error> {
        let depth = [
            paths.comment,
            paths.invalid,
            paths.changed,
            paths.inserted,
            paths.deleted,
        ]
        .iter()
        .map(|p| p.len())
        .max()
        .unwrap_or(0);
        Self::allocation(theme, depth)?;
        let base = resolver::native_default(theme);
        let resolver = Resolver::native_with_default(theme, base);
        let paths = [
            paths.comment,
            paths.invalid,
            paths.changed,
            paths.inserted,
            paths.deleted,
        ];
        let depth = paths.iter().map(|p| p.len()).max().unwrap_or(0);
        let mut cursor = resolver.cursor(depth)?;
        let mut hints = Vec::with_capacity(5);
        for path in paths {
            let value = cursor.resolve(path)?;
            let explicit = |d: Option<resolver::Declaration>| d.is_some_and(|d| d.explicit_path);
            hints.push(Hint {
                foreground: explicit(value.foreground).then(|| ColorRef {
                    color: value.expression.foreground.clone(),
                    origin: Origin::Theme,
                }),
                background: explicit(value.background).then(|| ColorRef {
                    color: value.expression.background.clone(),
                    origin: Origin::Theme,
                }),
                attributes: value.expression.attributes
                    & value
                        .attributes
                        .iter()
                        .enumerate()
                        .fold(0, |mask, (i, owner)| {
                            mask | if explicit(*owner) { 1 << i } else { 0 }
                        }),
            });
        }
        let palette = derive(
            theme,
            base.foreground,
            resolver.default_expression(),
            &hints,
        );
        Ok(Self { resolver, palette })
    }
}
fn linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}
fn luminance(color: &Ink) -> Option<f64> {
    match color {
        Ink::Rgb { r, g, b } => Some(
            0.2126 * linear(*r as f64 / 255.0)
                + 0.7152 * linear(*g as f64 / 255.0)
                + 0.0722 * linear(*b as f64 / 255.0),
        ),
        _ => None,
    }
}
fn ratio(a: f64, b: f64) -> f64 {
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}
fn contrast(a: &Ink, b: &Ink) -> Option<f64> {
    Some(ratio(luminance(a)?, luminance(b)?))
}

// The four matrices/transfer functions below are the small sRGB/Oklab subset of
// pi-tui 1.0.0 dist/oklab.js (Björn Ottosson's reference port), not OKHSL.
// Copyright (c) 2021 Björn Ottosson. MIT permission notice:
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to do
// so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of
// the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
const RGB_LMS: [[f64; 3]; 3] = [
    [0.4122214694707629, 0.5363325372617349, 0.0514459932675022],
    [0.2119034958178251, 0.6806995506452344, 0.1073969535369405],
    [0.0883024591900564, 0.2817188391361215, 0.6299787016738222],
];
const LMS_LAB: [[f64; 3]; 3] = [
    [0.210454268309314, 0.793617774702305, -0.0040720430116193],
    [1.9779985324311684, -2.42859224204858, 0.450593709617411],
    [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const LAB_LMS: [[f64; 3]; 3] = [
    [1.0, 0.3963377773761749, 0.2158037573099136],
    [1.0, -0.1055613458156586, -0.0638541728258133],
    [1.0, -0.0894841775298119, -1.2914855480194092],
];
const LMS_RGB: [[f64; 3]; 3] = [
    [
        4.076_741_636_075_958,
        -3.307_711_539_258_063,
        0.2309699031821043,
    ],
    [
        -1.2684379732850315,
        2.609_757_349_287_688,
        -0.341319376002657,
    ],
    [-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
];
fn multiply(m: [[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    m.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
}
#[derive(Clone, Copy)]
struct Lab {
    l: f64,
    a: f64,
    b: f64,
}
fn lab(color: &Ink) -> Option<Lab> {
    let Ink::Rgb { r, g, b } = color else {
        return None;
    };
    let v = multiply(
        LMS_LAB,
        multiply(RGB_LMS, [r, g, b].map(|c| linear(*c as f64 / 255.0))).map(f64::cbrt),
    );
    // Preserve the public SDK's Oklch round trip, including degree normalization.
    let h = (v[2].atan2(v[1]) * 180.0 / std::f64::consts::PI + 360.0) % 360.0;
    let angle = h * std::f64::consts::PI / 180.0;
    let c = v[1].hypot(v[2]);
    Some(Lab {
        l: v[0],
        a: c * angle.cos(),
        b: c * angle.sin(),
    })
}
fn paint(target: Lab, counters: &mut Counters) -> Ink {
    counters.paint_candidates += 1;
    let h = target.b.atan2(target.a) * 180.0 / std::f64::consts::PI;
    let angle = ((h % 360.0 + 360.0) % 360.0) * std::f64::consts::PI / 180.0;
    let c = target.a.hypot(target.b);
    let at = |chroma: f64| {
        multiply(
            LMS_RGB,
            multiply(
                LAB_LMS,
                [
                    target.l.clamp(0.0, 1.0),
                    chroma * angle.cos(),
                    chroma * angle.sin(),
                ],
            )
            .map(|x| x.powi(3)),
        )
    };
    let inside = |rgb: [f64; 3]| rgb.iter().all(|c| *c >= -1e-7 && *c <= 1.0 + 1e-7);
    let mut rgb = at(c);
    if !inside(rgb) {
        let (mut low, mut high) = (0.0, c);
        rgb = at(0.0);
        for _ in 0..20 {
            counters.gamut_bisections += 1;
            let middle = (low + high) / 2.0;
            let candidate = at(middle);
            if inside(candidate) {
                low = middle;
                rgb = candidate;
            } else {
                high = middle;
            }
        }
    }
    let channel = |x: f64| {
        let encoded = if x > 0.0031308 {
            1.055 * x.powf(1.0 / 2.4) - 0.055
        } else {
            12.92 * x
        };
        (encoded.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    let [r, g, b] = rgb.map(channel);
    Ink::Rgb { r, g, b }
}
fn within(color: &Ink, base: &Ink) -> bool {
    let (Some(a), Some(b)) = (lab(color), lab(base)) else {
        return false;
    };
    (a.l - b.l).abs() <= LIGHTNESS + 0.002 && (a.a - b.a).hypot(a.b - b.b) <= CHROMA + 0.003
}
fn readable_ink(
    preferred: ColorRef,
    surface: &ColorRef,
    minimum: f64,
    candidates: &[(ColorRef, Option<f64>)],
    counters: &mut Counters,
) -> ColorRef {
    let Some(current) = contrast(&preferred.color, &surface.color) else {
        return preferred;
    };
    if current >= minimum {
        return preferred;
    }
    let base = luminance(&surface.color).unwrap();
    let mut best = &preferred;
    let mut score = current;
    for (candidate, light) in candidates {
        counters.candidate_visits += 1;
        if let Some(light) = light {
            let candidate_score = ratio(*light, base);
            // Strict greater preserves the frozen JS stable sort's first-tie owner.
            if candidate_score > score {
                best = candidate;
                score = candidate_score;
            }
        }
    }
    if score > current {
        ColorRef {
            color: best.color.clone(),
            origin: Origin::Derived,
        }
    } else {
        preferred
    }
}
fn tint(
    base: &ColorRef,
    hint: Option<&ColorRef>,
    inks: &[(Ink, f64)],
    counters: &mut Counters,
) -> ColorRef {
    counters.tint_requests += 1;
    let result = |color, origin| ColorRef { color, origin };
    let Some(hint) = hint else {
        return result(base.color.clone(), base.origin);
    };
    let (Some(origin), Some(semantic), Some(base_light)) =
        (lab(&base.color), lab(&hint.color), luminance(&base.color))
    else {
        return result(base.color.clone(), Origin::TerminalDependent);
    };
    if inks.iter().any(|(ink, _)| luminance(ink).is_none()) {
        return result(base.color.clone(), Origin::TerminalDependent);
    }
    let mut constraints = Vec::with_capacity(inks.len());
    for (color, minimum) in inks {
        let light = luminance(color).unwrap();
        constraints.push((light, minimum.min(ratio(light, base_light))));
    }
    let valid = |color, counters: &mut Counters| {
        if !within(&color, &base.color) {
            return false;
        }
        let actual = luminance(&color).unwrap();
        constraints.iter().all(|(light, minimum)| {
            counters.quantized_ink_checks += 1;
            ratio(actual, *light) / minimum >= 1.0
        })
    };
    let da = semantic.a - origin.a;
    let db = semantic.b - origin.b;
    let distance = da.hypot(db);
    let amount = (CHROMA / if distance == 0.0 { 1.0 } else { distance }).min(1.0);
    let target = Lab {
        l: origin.l + (semantic.l - origin.l).clamp(-LIGHTNESS, LIGHTNESS),
        a: origin.a + da * amount,
        b: origin.b + db * amount,
    };
    let initial = paint(target, counters);
    if valid(initial.clone(), counters) {
        return result(initial, Origin::Derived);
    }
    let mut ends = [
        (origin.l - LIGHTNESS).clamp(0.0, 1.0),
        (origin.l + LIGHTNESS).clamp(0.0, 1.0),
    ];
    ends.sort_by(|a, b| (a - target.l).abs().total_cmp(&(b - target.l).abs()));
    for end in ends {
        let mut color = paint(Lab { l: end, ..target }, counters);
        if !valid(color.clone(), counters) {
            continue;
        }
        let (mut failed, mut accepted) = (target.l, end);
        for _ in 0..12 {
            let middle = (failed + accepted) / 2.0;
            let candidate = paint(
                Lab {
                    l: middle,
                    ..target
                },
                counters,
            );
            if valid(candidate.clone(), counters) {
                accepted = middle;
                color = candidate;
            } else {
                failed = middle;
            }
        }
        return result(color, Origin::Derived);
    }
    result(base.color.clone(), base.origin)
}

// Alphabetical order reproduces the gate's stable candidate tie ownership, without
// serializing ThemeSettings or including non-color CSS/underline-option settings.
fn settings(s: &ThemeSettings) -> [Option<Color>; 25] {
    [
        s.accent,
        s.active_guide,
        s.background,
        s.bracket_contents_foreground,
        s.brackets_background,
        s.brackets_foreground,
        s.caret,
        s.find_highlight,
        s.find_highlight_foreground,
        s.foreground,
        s.guide,
        s.gutter,
        s.gutter_foreground,
        s.highlight,
        s.inactive_selection,
        s.inactive_selection_foreground,
        s.line_highlight,
        s.minimap_border,
        s.misspelling,
        s.selection,
        s.selection_border,
        s.selection_foreground,
        s.shadow,
        s.stack_guide,
        s.tags_foreground,
    ]
}
fn derive(
    theme: &Theme,
    default_foreground: Color,
    default: &Expression,
    hints: &[Hint],
) -> Palette {
    let [comment_hint, invalid, changed, inserted, deleted] = hints else {
        unreachable!()
    };
    let mut counters = Counters {
        palettes: 1,
        ..Counters::default()
    };
    let s = &theme.settings;
    let fg = ColorRef {
        color: default.foreground.clone(),
        origin: Origin::Theme,
    };
    let panel = ColorRef {
        color: default.background.clone(),
        origin: Origin::Theme,
    };
    let gutter = s
        .gutter
        .map(ColorRef::native)
        .unwrap_or_else(|| panel.clone());
    let ink_capacity = 1 + theme
        .scopes
        .iter()
        .filter(|item| item.style.foreground.is_some())
        .count();
    let mut native =
        Vec::with_capacity(2 + settings(s).iter().flatten().count() + 10 + ink_capacity);
    native.extend([fg.clone(), panel.clone()]);
    native.extend(settings(s).into_iter().flatten().map(ColorRef::native));
    for hint in [changed, comment_hint, deleted, inserted, invalid] {
        native.extend(
            hint.foreground
                .iter()
                .chain(hint.background.iter())
                .cloned(),
        );
    }
    // Full default/declared ink set: never reduce native constraints to Pi roles.
    let mut raw_inks = Vec::with_capacity(ink_capacity);
    raw_inks.push(default_foreground);
    for item in &theme.scopes {
        if let Some(fg) = item.style.foreground {
            if !raw_inks.contains(&fg) {
                raw_inks.push(fg);
            }
        }
    }
    counters.native_ink_entries = raw_inks.len();
    let mut syntax_inks = Vec::with_capacity(raw_inks.len());
    syntax_inks.extend(raw_inks.into_iter().map(resolver::native_ink));
    native.extend(syntax_inks.iter().cloned().map(|color| ColorRef {
        color,
        origin: Origin::Theme,
    }));
    let mut candidates = Vec::with_capacity(native.len());
    for color in native {
        let light = luminance(&color.color);
        candidates.push((color, light));
    }
    let comment = comment_hint
        .foreground
        .clone()
        .unwrap_or_else(|| fg.clone());
    let secondary = readable_ink(comment.clone(), &panel, 3.0, &candidates, &mut counters);
    let title = readable_ink(
        s.accent.map(ColorRef::native).unwrap_or_else(|| fg.clone()),
        &panel,
        3.0,
        &candidates,
        &mut counters,
    );
    let frame = readable_ink(
        s.accent.map(ColorRef::native).unwrap_or(comment.clone()),
        &panel,
        3.0,
        &candidates,
        &mut counters,
    );
    let error = readable_ink(
        invalid
            .foreground
            .clone()
            .or_else(|| changed.foreground.clone())
            .unwrap_or_else(|| fg.clone()),
        &panel,
        4.5,
        &candidates,
        &mut counters,
    );
    let warning = readable_ink(
        changed.foreground.clone().unwrap_or_else(|| error.clone()),
        &panel,
        4.5,
        &candidates,
        &mut counters,
    );
    let numbers = readable_ink(
        s.gutter_foreground.map(ColorRef::native).unwrap_or(comment),
        &gutter,
        3.0,
        &candidates,
        &mut counters,
    );
    let prompt = readable_ink(fg.clone(), &panel, 3.0, &candidates, &mut counters);
    let mut constraints = Vec::with_capacity(syntax_inks.len() + 1);
    constraints.push((fg.color.clone(), 4.5));
    constraints.extend(syntax_inks.into_iter().map(|color| (color, 4.5)));
    let base = Expression {
        foreground: fg.color.clone(),
        background: panel.color.clone(),
        attributes: 0,
        attribute_mask: resolver::ALL_ATTRIBUTES,
    };
    let mut palette = Palette {
        slots: std::array::from_fn(|_| base.clone()),
        origins: [0; CARD_SLOTS],
        counters: Counters::default(),
    };
    let mut put =
        |index: usize, fg: &ColorRef, bg: &ColorRef, attributes: u8, font_derived: bool| {
            palette.slots[index] = Expression {
                foreground: fg.color.clone(),
                background: bg.color.clone(),
                attributes,
                attribute_mask: resolver::ALL_ATTRIBUTES,
            };
            palette.origins[index] =
                fg.encoded_origin() | (bg.encoded_origin() << 2) | (u8::from(font_derived) << 4);
        };
    for index in 0..6 {
        put(index, &fg, &panel, 0, false);
    }
    for index in 6..12 {
        put(index, &secondary, &panel, 0, false);
    }
    put(12, &title, &panel, 0, false);
    put(13, &prompt, &panel, 0, false);
    put(14, &frame, &panel, 0, false);
    put(15, &error, &panel, invalid.attributes, false);
    put(
        16,
        &error,
        &panel,
        invalid.attributes | resolver::BOLD,
        true,
    );
    put(17, &warning, &panel, changed.attributes, false);
    put(18, &numbers, &gutter, 0, false);
    put(19, &numbers, &gutter, 0, false);
    for (start, hint) in [(20, inserted), (23, deleted)] {
        let sign = readable_ink(
            hint.foreground.clone().unwrap_or_else(|| fg.clone()),
            &gutter,
            4.5,
            &candidates,
            &mut counters,
        );
        let semantic = hint.background.as_ref().or(hint.foreground.as_ref());
        let code_surface = tint(&panel, semantic, &constraints, &mut counters);
        let mut gutter_inks = Vec::with_capacity(constraints.len() + 2);
        gutter_inks.extend(constraints.iter().cloned());
        gutter_inks.extend([(numbers.color.clone(), 3.0), (sign.color.clone(), 4.5)]);
        let gutter_surface = tint(&gutter, semantic, &gutter_inks, &mut counters);
        put(start, &fg, &code_surface, 0, false);
        put(start + 1, &numbers, &gutter_surface, 0, false);
        put(start + 2, &sign, &gutter_surface, hint.attributes, false);
    }
    palette.counters = counters;
    palette
}
