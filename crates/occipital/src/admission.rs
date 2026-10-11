//! Pure, pre-intern admission for changed .tmTheme definitions.
//!
//! The caller owns one `Admission` for the entire process lifetime and bypasses
//! this boundary for unchanged hashes. Dropping a Theme does not reclaim Syntect
//! atoms. This module does not own a catalogue, files, or rendering policy.
use std::{fmt, io::Cursor, str::FromStr};

use serde_json::{Map, Value};
use syntect::highlighting::{Color, FontStyle, ParseThemeError, Theme, ThemeSet, UnderlineOption};

/// Defaults are the admission contract; overrides permit isolated calibration/tests.
/// Scope depth is always the public Syntect maximum of eight (not configurable).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub file_bytes: usize,
    /// Union branches across all rule scope strings, including empty branches.
    pub selectors: usize,
    /// Paths including empty exclusions, bounded before native selector construction.
    pub selector_paths: usize,
    pub attempts: usize,
    pub definition_bytes: usize,
    /// Decoded scope-string bytes, including separators and whitespace.
    pub selector_bytes: usize,
    /// Occurrences, not distinct atoms; includes repeated and empty interior atoms.
    pub atom_occurrences: usize,
    /// Collection nesting before recursive plist/Value decoding.
    pub plist_depth: usize,
    /// Expanded event stream, including scalar and end-collection events.
    pub plist_events: usize,
    /// Expanded string/data payload bytes (binary references count each visit).
    pub expanded_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: 128 * 1024,
            // Calibrated against all pinned presets: Catppuccin uses 387 branches.
            selectors: crate::profile::THEME_SELECTORS,
            selector_paths: crate::profile::THEME_PATHS,
            attempts: 64,
            definition_bytes: 8 * 1024 * 1024,
            selector_bytes: 256 * 1024,
            atom_occurrences: 4096,
            plist_depth: 128,
            plist_events: 8192,
            expanded_bytes: 128 * 1024,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Counters {
    pub attempts: usize,
    pub definition_bytes: usize,
    pub selector_bytes: usize,
    pub atom_occurrences: usize,
    /// Calls to the public ThemeSet loader, never preflight calls.
    pub syntect_loads: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resource {
    FileBytes,
    Selectors,
    SelectorPaths,
    Attempts,
    DefinitionBytes,
    SelectorBytes,
    AtomOccurrences,
    PlistDepth,
    PlistEvents,
    ExpandedBytes,
}

/// Item indices refer to the raw settings array (global settings is item zero).
#[derive(Debug)]
pub enum AdmissionError {
    Limit {
        resource: Resource,
        limit: usize,
    },
    Plist(plist::Error),
    Xml(quick_xml::Error),
    XmlStructure(&'static str),
    Structure {
        item: Option<usize>,
        field: &'static str,
    },
    NonAsciiSelector {
        item: usize,
    },
    ScopeDepth {
        item: usize,
        atoms: usize,
    },
    Style {
        item: Option<usize>,
        field: &'static str,
        source: ParseThemeError,
    },
    Syntect(syntect::LoadingError),
}

impl fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Limit { resource, limit } => {
                write!(f, "theme admission {resource:?} limit {limit} exceeded")
            }
            Self::Plist(_) => f.write_str("invalid theme plist"),
            Self::Xml(_) => f.write_str("invalid theme XML"),
            Self::XmlStructure(reason) => write!(f, "invalid theme XML: {reason}"),
            Self::Structure { item, field } => {
                write!(f, "invalid theme field {field} at item {item:?}")
            }
            Self::NonAsciiSelector { item } => write!(f, "non-ASCII selector at item {item}"),
            Self::ScopeDepth { item, atoms } => {
                write!(f, "scope at item {item} has {atoms} atoms; maximum is 8")
            }
            Self::Style { item, field, .. } => {
                write!(f, "invalid theme style {field} at item {item:?}")
            }
            Self::Syntect(_) => f.write_str("Syntect theme load failed"),
        }
    }
}

impl std::error::Error for AdmissionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Plist(source) => Some(source),
            Self::Xml(source) => Some(source),
            Self::Style { source, .. } => Some(source),
            Self::Syntect(source) => Some(source),
            _ => None,
        }
    }
}

/// No reset/clone API: reuse this owner across failed refreshes and catalogue drops.
/// This controls only atoms introduced through custom-definition admission, not
/// grammar assets, bundled themes or other users of Syntect's global repository.
pub struct Admission {
    limits: Limits,
    counters: Counters,
}

impl Admission {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            counters: Counters::default(),
        }
    }

    pub fn counters(&self) -> Counters {
        self.counters
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// Charges in stages before the corresponding parser boundary, never refunds:
    /// 1. attempt; 2. raw bytes; 3. decoded selector bytes + atoms together.
    ///
    /// A denied stage does not exceed its cap, but earlier charges remain. Invalid
    /// plist has no decoded selector charge; oversized input is never decoded.
    pub fn admit(&mut self, definition: &[u8]) -> Result<Theme, AdmissionError> {
        self.counters.attempts = reserve(
            self.counters.attempts,
            1,
            self.limits.attempts,
            Resource::Attempts,
        )?;
        self.counters.definition_bytes = reserve(
            self.counters.definition_bytes,
            definition.len(),
            self.limits.definition_bytes,
            Resource::DefinitionBytes,
        )?;
        if definition.len() > self.limits.file_bytes {
            return Err(limit(Resource::FileBytes, self.limits.file_bytes));
        }

        check_structure_stream(definition, self.limits)?;

        // Same public plist deserializer and target type as Syntect read_plist:
        // no selectors or atoms are parsed here, and malformed plist never reaches it.
        let raw: Value =
            plist::from_reader(Cursor::new(definition)).map_err(AdmissionError::Plist)?;
        let measurement = measure(&raw)?;
        let selector_bytes = reserve(
            self.counters.selector_bytes,
            measurement.bytes,
            self.limits.selector_bytes,
            Resource::SelectorBytes,
        )?;
        let atoms = reserve(
            self.counters.atom_occurrences,
            measurement.atoms,
            self.limits.atom_occurrences,
            Resource::AtomOccurrences,
        )?;
        self.counters.selector_bytes = selector_bytes;
        self.counters.atom_occurrences = atoms;
        if measurement.selectors > self.limits.selectors {
            return Err(limit(Resource::Selectors, self.limits.selectors));
        }
        if measurement.paths > self.limits.selector_paths {
            return Err(limit(Resource::SelectorPaths, self.limits.selector_paths));
        }
        if let Some(error) = measurement.error {
            return Err(error);
        }
        validate_structure_and_styles(&raw)?;
        drop(raw);

        // All selectors in the complete definition passed preflight. Native scope
        // build() interns before its depth/index errors, so never use it as a guard.
        self.counters.syntect_loads += 1; // bounded by the checked attempt counter
        ThemeSet::load_from_reader(&mut Cursor::new(definition)).map_err(AdmissionError::Syntect)
    }
}

fn limit(resource: Resource, limit: usize) -> AdmissionError {
    AdmissionError::Limit { resource, limit }
}

fn reserve(
    used: usize,
    amount: usize,
    cap: usize,
    resource: Resource,
) -> Result<usize, AdmissionError> {
    used.checked_add(amount)
        .filter(|&total| total <= cap)
        .ok_or_else(|| limit(resource, cap))
}

#[derive(Default)]
struct Measurement {
    bytes: usize,
    atoms: usize,
    selectors: usize,
    paths: usize,
    error: Option<AdmissionError>,
}

fn measure(raw: &Value) -> Result<Measurement, AdmissionError> {
    let mut result = Measurement::default();
    // Native Theme::parse_settings treats the first entry as global settings and
    // ignores any scope there. Measure all later strings even if a rule is invalid.
    if let Some(items) = raw.get("settings").and_then(Value::as_array) {
        for (item, rule) in items.iter().enumerate().skip(1) {
            let Some(text) = rule.get("scope").and_then(Value::as_str) else {
                continue;
            };
            result.bytes = reserve(
                result.bytes,
                text.len(),
                usize::MAX,
                Resource::SelectorBytes,
            )?;
            if !text.is_ascii() && result.error.is_none() {
                result.error = Some(AdmissionError::NonAsciiSelector { item });
            }
            // Exact public ScopeSelectors -> ScopeSelector -> ScopeStack grammar.
            // A hyphen is exclusion only after a literal space, NOT any whitespace.
            for selector in text.split([',', '|']) {
                result.selectors = reserve(result.selectors, 1, usize::MAX, Resource::Selectors)?;
                for stack in selector.split(" -") {
                    result.paths = reserve(result.paths, 1, usize::MAX, Resource::SelectorPaths)?;
                    for term in stack.split_whitespace() {
                        // Scope::new trims whitespace; build trims ALL trailing dots.
                        // A dot-only term still interns one empty atom, as do interior
                        // empty parts. Empty stacks do not call Scope::new at all.
                        let atoms = term.trim_end_matches('.').split('.').count();
                        result.atoms =
                            reserve(result.atoms, atoms, usize::MAX, Resource::AtomOccurrences)?;
                        if atoms > 8 && result.error.is_none() {
                            result.error = Some(AdmissionError::ScopeDepth { item, atoms });
                        }
                    }
                }
            }
        }
    }
    Ok(result)
}

fn structure(item: Option<usize>, field: &'static str) -> AdmissionError {
    AdmissionError::Structure { item, field }
}

fn object<'a>(
    value: &'a Value,
    item: Option<usize>,
    field: &'static str,
) -> Result<&'a Map<String, Value>, AdmissionError> {
    value.as_object().ok_or_else(|| structure(item, field))
}

fn validate_structure_and_styles(raw: &Value) -> Result<(), AdmissionError> {
    let root = object(raw, None, "root")?;
    for field in ["name", "author"] {
        if root.get(field).is_some_and(|v| !v.is_string()) {
            return Err(structure(None, field));
        }
    }
    let items = root
        .get("settings")
        .and_then(Value::as_array)
        .ok_or_else(|| structure(None, "settings"))?;
    let first = items
        .first()
        .ok_or_else(|| structure(Some(0), "settings"))?;
    let first = object(first, Some(0), "settings")?;
    let global = first
        .get("settings")
        .ok_or_else(|| structure(Some(0), "settings"))?;
    validate_global(object(global, Some(0), "settings")?)?;
    if let Some(gutter) = root.get("gutterSettings") {
        let gutter = object(gutter, None, "gutterSettings")?;
        for field in ["foreground", "background"] {
            validate_color(gutter, None, field)?;
        }
    }
    for (index, rule) in items.iter().enumerate().skip(1) {
        let rule = object(rule, Some(index), "rule")?;
        if !rule.get("scope").is_some_and(Value::is_string) {
            return Err(structure(Some(index), "scope"));
        }
        let style = rule
            .get("settings")
            .ok_or_else(|| structure(Some(index), "settings"))?;
        let style = object(style, Some(index), "settings")?;
        for field in ["foreground", "background"] {
            validate_color(style, Some(index), field)?;
        }
        validate_parsed(style, Some(index), "fontStyle", FontStyle::from_str)?;
    }
    Ok(())
}

fn validate_global(global: &Map<String, Value>) -> Result<(), AdmissionError> {
    // Public ThemeSettings::parse_settings color/underline keys in Syntect 5.3.0.
    // Unknown metadata remains native; admission does not project any style.
    for field in [
        "foreground",
        "background",
        "caret",
        "lineHighlight",
        "misspelling",
        "minimapBorder",
        "accent",
        "bracketContentsForeground",
        "bracketsForeground",
        "bracketsBackground",
        "tagsForeground",
        "highlight",
        "findHighlight",
        "findHighlightForeground",
        "gutter",
        "gutterForeground",
        "selection",
        "selectionForeground",
        "selectionBorder",
        "inactiveSelection",
        "inactiveSelectionForeground",
        "guide",
        "activeGuide",
        "stackGuide",
        "shadow",
    ] {
        validate_color(global, Some(0), field)?;
    }
    for field in ["bracketContentsOptions", "bracketsOptions", "tagsOptions"] {
        validate_parsed(global, Some(0), field, UnderlineOption::from_str)?;
    }
    Ok(())
}

fn validate_color(
    values: &Map<String, Value>,
    item: Option<usize>,
    field: &'static str,
) -> Result<(), AdmissionError> {
    validate_parsed(values, item, field, Color::from_str)
}

fn validate_parsed<T>(
    values: &Map<String, Value>,
    item: Option<usize>,
    field: &'static str,
    parse: impl FnOnce(&str) -> Result<T, ParseThemeError>,
) -> Result<(), AdmissionError> {
    if let Some(value) = values.get(field) {
        let parsed = value
            .as_str()
            .ok_or(match field {
                "fontStyle" => ParseThemeError::IncorrectFontStyle("non-string".into()),
                "bracketContentsOptions" | "bracketsOptions" | "tagsOptions" => {
                    ParseThemeError::IncorrectUnderlineOption
                }
                _ => ParseThemeError::IncorrectColor,
            })
            .and_then(parse);
        parsed.map_err(|source| AdmissionError::Style {
            item,
            field,
            source,
        })?;
    }
    Ok(())
}

// Exact plist pinning and compilation guard these public, feature-gated APIs.
fn check_structure_stream(definition: &[u8], limits: Limits) -> Result<(), AdmissionError> {
    if definition.starts_with(b"bplist00") {
        // BinaryReader is iterative and rejects cycles, but repeated references
        // can expand exponentially; bound the events before Value decoding.
        check_events(
            plist::stream::BinaryReader::new(Cursor::new(definition)),
            limits,
        )
    } else {
        // Reader::init tries XML first and permits ASCII fallback only before
        // XML has started. A native Theme needs an ASCII dictionary root: its
        // first public event proves the input starts with that dictionary (or
        // ASCII comments before it), not XML markup/declarations. Never retry a
        // failed XML framing check as ASCII. Both probes are iterative/bounded
        // by the already-admitted immutable file bytes, with no semantic tree.
        let xml_first = plist::stream::XmlReader::new(Cursor::new(definition)).next();
        if matches!(xml_first, Some(Err(_)))
            && matches!(
                plist::stream::AsciiReader::new(Cursor::new(definition)).next(),
                Some(Ok(plist::stream::Event::StartDictionary(_)))
            )
        {
            check_events(
                plist::stream::AsciiReader::new(Cursor::new(definition)),
                limits,
            )
        } else {
            check_xml(definition, limits)?;
            check_events(
                plist::stream::XmlReader::new(Cursor::new(definition)),
                limits,
            )
        }
    }
}

fn check_events(
    events: impl Iterator<Item = Result<plist::stream::OwnedEvent, plist::Error>>,
    limits: Limits,
) -> Result<(), AdmissionError> {
    use plist::stream::Event;
    let (mut count, mut depth, mut bytes) = (0, 0usize, 0);
    for event in events {
        let event = event.map_err(AdmissionError::Plist)?;
        count = reserve(count, 1, limits.plist_events, Resource::PlistEvents)?;
        match event {
            Event::StartArray(_) | Event::StartDictionary(_) => {
                depth = reserve(depth, 1, limits.plist_depth, Resource::PlistDepth)?;
            }
            Event::EndCollection => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| structure(None, "plist nesting"))?;
            }
            Event::String(value) => {
                bytes = reserve(
                    bytes,
                    value.len(),
                    limits.expanded_bytes,
                    Resource::ExpandedBytes,
                )?;
            }
            Event::Data(value) => {
                bytes = reserve(
                    bytes,
                    value.len(),
                    limits.expanded_bytes,
                    Resource::ExpandedBytes,
                )?;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(structure(None, "plist nesting"));
    }
    Ok(())
}

// Full-document scan, not an XML tree or another theme interpretation. DTDs
// are never fetched/expanded; a framing failure never changes the encoding path.
fn check_xml(definition: &[u8], limits: Limits) -> Result<(), AdmissionError> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(definition);
    reader.config_mut().check_end_names = true;
    reader.config_mut().check_comments = true;
    let (mut depth, mut roots, mut declaration, mut doctype) = (0usize, 0usize, false, false);
    let mut version = quick_xml::XmlVersion::Implicit1_0;
    loop {
        let event = reader.read_event().map_err(AdmissionError::Xml)?;
        let opens = matches!(event, Event::Start(_));
        match event {
            Event::Start(tag) | Event::Empty(tag) => {
                if depth == 0 {
                    roots += 1;
                    if roots > 1 {
                        return Err(AdmissionError::XmlStructure("multiple document roots"));
                    }
                }
                for attribute in tag.attributes().with_checks(true) {
                    attribute
                        .map_err(|e| AdmissionError::Xml(e.into()))?
                        .normalized_value(version)
                        .map_err(AdmissionError::Xml)?;
                }
                if opens {
                    // XML wrapper and leaf element add at most two levels above
                    // the actual collection depth, checked by the plist stream.
                    depth = reserve(
                        depth,
                        1,
                        limits.plist_depth.saturating_add(2),
                        Resource::PlistDepth,
                    )?;
                }
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or(AdmissionError::XmlStructure("unmatched end tag"))?;
            }
            Event::Text(text) => {
                if depth == 0
                    && !text
                        .chars()
                        .all(|ch| matches!(ch, ' ' | '\t' | '\r' | '\n'))
                {
                    return Err(AdmissionError::XmlStructure("text outside document root"));
                }
            }
            Event::CData(_) if depth == 0 => {
                return Err(AdmissionError::XmlStructure("CDATA outside document root"))
            }
            Event::GeneralRef(reference) => {
                if depth == 0 {
                    return Err(AdmissionError::XmlStructure(
                        "reference outside document root",
                    ));
                }
                if reference
                    .resolve_char_ref()
                    .map_err(AdmissionError::Xml)?
                    .is_none()
                    && quick_xml::escape::resolve_xml_entity(&reference).is_none()
                {
                    return Err(AdmissionError::XmlStructure("undefined XML entity"));
                }
            }
            Event::Decl(decl) => {
                if roots != 0 || declaration || doctype {
                    return Err(AdmissionError::XmlStructure("misplaced XML declaration"));
                }
                version = match decl.version().map_err(AdmissionError::Xml)?.as_ref() {
                    "1.0" => quick_xml::XmlVersion::Explicit1_0,
                    "1.1" => quick_xml::XmlVersion::Explicit1_1,
                    _ => return Err(AdmissionError::XmlStructure("unsupported XML version")),
                };
                declaration = true;
            }
            Event::DocType(_) => {
                if roots != 0 || doctype {
                    return Err(AdmissionError::XmlStructure("misplaced document type"));
                }
                doctype = true;
            }
            Event::Eof => {
                if depth != 0 {
                    return Err(AdmissionError::XmlStructure("unclosed XML element"));
                }
                if roots != 1 {
                    return Err(AdmissionError::XmlStructure("expected one document root"));
                }
                return Ok(());
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_overflow_never_wraps_or_mutates() {
        assert!(matches!(
            reserve(usize::MAX, 1, usize::MAX, Resource::DefinitionBytes),
            Err(AdmissionError::Limit {
                resource: Resource::DefinitionBytes,
                ..
            })
        ));
        assert_eq!(
            reserve(usize::MAX - 1, 1, usize::MAX, Resource::DefinitionBytes).unwrap(),
            usize::MAX
        );
    }
}
