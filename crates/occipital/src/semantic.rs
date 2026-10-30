//! Theme-independent v4 payload primitives.
use serde::{de, de::DeserializeSeed, Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{collections::HashSet, fmt};

pub const PROTOCOL_VERSION: u32 = 4;
pub const CAPABILITY: &str = "syntax-highlight/v4";
use crate::limits::{CONTEXT_ROW_UNITS as ROW_UNITS, CONTEXT_WORD_UNITS as WORD_UNITS};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidContext,
    UnknownScope,
    ContextLimit,
    InvalidStyle,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidContext => "invalid_context",
            Self::UnknownScope => "unknown_scope",
            Self::ContextLimit => "context_limit",
            Self::InvalidStyle => "invalid_style",
        }
    }
}
#[derive(Clone, Copy)]
pub struct Bounds {
    pub vocabulary_size: u32,
    pub max_bytes: usize,
}
#[derive(Debug, Default, Clone, Copy)]
pub struct Measurement {
    pub words: usize,
    pub policy_bytes: usize,
    pub rows: usize,
}
struct Scan {
    measurement: Measurement,
    failure: Option<Error>,
    bounds: Bounds,
}
impl Scan {
    fn reject<E: de::Error>(&mut self, error: Error) -> E {
        self.failure = Some(error);
        E::custom(error.code())
    }
    fn words<E: de::Error>(&mut self, count: usize) -> Result<(), E> {
        let Some(total) = self.measurement.words.checked_add(count) else {
            return Err(self.reject(Error::ContextLimit));
        };
        if total > crate::limits::CONTEXT_WORDS {
            return Err(self.reject(Error::ContextLimit));
        }
        self.measurement.words = total;
        Ok(())
    }
    fn charge<E: de::Error>(&mut self, units: usize) -> Result<(), E> {
        let Some(total) = self.measurement.policy_bytes.checked_add(units) else {
            return Err(self.reject(Error::ContextLimit));
        };
        if total > self.bounds.max_bytes {
            return Err(self.reject(Error::ContextLimit));
        }
        self.measurement.policy_bytes = total;
        Ok(())
    }
}
// Parse the complete valid JSON token: Serde's approximate decimal conversion
// can otherwise turn a fractional scope ID into an accepted integer.
fn unsigned(value: &RawValue) -> Option<u32> {
    let n = value.get().trim().parse::<f64>().ok()?;
    (n.is_finite() && n >= 0.0 && n <= f64::from(u32::MAX) && n.fract() == 0.0).then_some(n as u32)
}
struct Rows<'a> {
    scan: &'a mut Scan,
    output: Option<&'a mut Vec<Vec<u32>>>,
}
impl<'de> DeserializeSeed<'de> for Rows<'_> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> de::Visitor<'de> for Rows<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("context rows")
    }
    fn visit_seq<A: de::SeqAccess<'de>>(mut self, mut seq: A) -> Result<(), A::Error> {
        let mut previous_depth = 0;
        while seq
            .next_element_seed(Row {
                scan: self.scan,
                previous_depth: &mut previous_depth,
                output: self.output.as_deref_mut(),
            })?
            .is_some()
        {}
        Ok(())
    }
}
struct Row<'a> {
    scan: &'a mut Scan,
    previous_depth: &'a mut usize,
    output: Option<&'a mut Vec<Vec<u32>>>,
}
impl<'de> DeserializeSeed<'de> for Row<'_> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> de::Visitor<'de> for Row<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("prefix and scope identifiers")
    }
    fn visit_seq<A: de::SeqAccess<'de>>(mut self, mut seq: A) -> Result<(), A::Error> {
        let prefix = seq.next_element::<&RawValue>()?.and_then(unsigned);
        let Some(prefix) = prefix
            .map(|n| n as usize)
            .filter(|&n| n <= *self.previous_depth)
        else {
            return Err(self.scan.reject(Error::InvalidContext));
        };
        self.scan.charge::<A::Error>(ROW_UNITS)?;
        self.scan.words::<A::Error>(prefix)?;
        self.scan.charge::<A::Error>(prefix * WORD_UNITS)?;
        let mut owned = self.output.as_ref().map(|paths| {
            let mut path = Vec::with_capacity(prefix);
            if prefix > 0 {
                path.extend_from_slice(&paths.last().unwrap()[..prefix]);
            }
            path
        });
        let mut depth = prefix;
        loop {
            let next = match seq.next_element::<&RawValue>() {
                Ok(value) => value,
                Err(_) => return Err(self.scan.reject(Error::UnknownScope)),
            };
            let Some(number) = next else {
                break;
            };
            let Some(id) =
                unsigned(number).filter(|&id| id > 0 && id <= self.scan.bounds.vocabulary_size)
            else {
                return Err(self.scan.reject(Error::UnknownScope));
            };
            self.scan.words::<A::Error>(1)?;
            self.scan.charge::<A::Error>(WORD_UNITS)?;
            depth += 1;
            if let Some(path) = &mut owned {
                path.push(id);
            }
        }
        self.scan.measurement.rows += 1;
        *self.previous_depth = depth;
        if let Some(paths) = self.output.as_mut() {
            paths.push(owned.unwrap());
        }
        Ok(())
    }
}
fn scan(raw: &RawValue, state: &mut Scan, output: Option<&mut Vec<Vec<u32>>>) -> Result<(), Error> {
    let mut decoder = serde_json::Deserializer::from_str(raw.get());
    let result = Rows {
        scan: state,
        output,
    }
    .deserialize(&mut decoder)
    .and_then(|()| decoder.end());
    result.map_err(|_| state.failure.unwrap_or(Error::InvalidContext))
}

/// Borrowed JSON is preflighted across the whole batch without a Value tree or
/// expanded word arrays. Its bytes cannot change between validation/materialization.
pub struct ContextPlan<'a> {
    raw: Vec<&'a RawValue>,
    rows: Vec<usize>,
    bounds: Bounds,
    measurement: Measurement,
}
impl<'a> ContextPlan<'a> {
    pub fn measurement(&self) -> Measurement {
        self.measurement
    }
    pub fn inspect(raw: &[&'a RawValue], bounds: Bounds) -> Result<Self, Error> {
        if raw.len() > crate::request::BATCH_SOURCES
            || bounds.vocabulary_size == 0
            || bounds.max_bytes > crate::limits::DATA_BYTES
        {
            return Err(Error::InvalidContext);
        }
        let mut raw_bytes = 0usize;
        for part in raw {
            raw_bytes = raw_bytes
                .checked_add(part.get().len())
                .ok_or(Error::ContextLimit)?;
            if raw_bytes > crate::limits::DATA_WIRE_BYTES {
                return Err(Error::ContextLimit);
            }
        }
        let bounds = Bounds {
            max_bytes: bounds.max_bytes.min(crate::limits::DECODED_BYTES),
            ..bounds
        };
        let mut state = Scan {
            measurement: Measurement::default(),
            failure: None,
            bounds,
        };
        let mut rows = Vec::with_capacity(raw.len());
        for &part in raw {
            let previous = state.measurement.rows;
            scan(part, &mut state, None)?;
            rows.push(state.measurement.rows - previous);
        }
        Ok(Self {
            raw: raw.to_vec(),
            rows,
            bounds,
            measurement: state.measurement,
        })
    }
    /// The caller reserves measurement.policy_bytes before this controlled allocation.
    pub fn materialize(self) -> Vec<Vec<Vec<u32>>> {
        let mut state = Scan {
            measurement: Measurement::default(),
            failure: None,
            bounds: self.bounds,
        };
        self.raw
            .into_iter()
            .zip(self.rows)
            .map(|(raw, rows)| {
                let mut paths = Vec::with_capacity(rows);
                scan(raw, &mut state, Some(&mut paths))
                    .expect("immutable preflighted context JSON");
                paths
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Ink {
    Rgb { r: u8, g: u8, b: u8 },
    Indexed { index: u8 },
    TerminalDefault {},
    Binding { slot: u16 },
    Inherit {},
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expression {
    pub foreground: Ink,
    pub background: Ink,
    pub attributes: u8,
    pub attribute_mask: u8,
}
impl Expression {
    pub fn validate(&self, binding_slots: u32) -> Result<(), Error> {
        let ink = |value: &Ink| match value {
            Ink::Binding { slot } => u32::from(*slot) < binding_slots,
            _ => true,
        };
        if self.attributes > 31
            || self.attribute_mask > 31
            || self.attributes & !self.attribute_mask != 0
            || !ink(&self.foreground)
            || !ink(&self.background)
        {
            return Err(Error::InvalidStyle);
        }
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StyleKind {
    Styles,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Styles {
    pub kind: StyleKind,
    pub vocabulary: String,
    pub rules: String,
    pub styles: Vec<Expression>,
    pub indices: Vec<u32>,
}
impl Styles {
    pub fn validate(&self, binding_slots: u32, contexts: usize) -> Result<(), Error> {
        let fingerprint = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if !fingerprint(&self.vocabulary)
            || !fingerprint(&self.rules)
            || self.indices.len() != contexts
        {
            return Err(Error::InvalidStyle);
        }
        let mut unique = HashSet::new();
        for style in &self.styles {
            style.validate(binding_slots)?;
            if !unique.insert(style) {
                return Err(Error::InvalidStyle);
            }
        }
        let valid_id = |&id: &u32| id > 0 && (id as usize) <= self.styles.len();
        if !self.indices.iter().all(valid_id) {
            return Err(Error::InvalidStyle);
        }
        let references: HashSet<_> = self.indices.iter().copied().collect();
        if references.len() != self.styles.len() {
            return Err(Error::InvalidStyle);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const VECTORS: &str = include_str!("../../../protocol/syntax-v4/vectors.json");
    fn raw(text: &str) -> Box<RawValue> {
        RawValue::from_string(text.to_owned()).unwrap()
    }
    const BOUNDS: Bounds = Bounds {
        vocabulary_size: 20,
        max_bytes: 1 << 20,
    };
    #[test]
    fn shared_context_vectors_are_checked_before_expansion() {
        let vectors: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        for case in vectors["contexts"].as_array().unwrap() {
            let raw = raw(&case["encoded"].to_string());
            let max_bytes = case["max_bytes"]
                .as_u64()
                .map_or(BOUNDS.max_bytes, |n| n as usize);
            match ContextPlan::inspect(
                &[&raw],
                Bounds {
                    max_bytes,
                    ..BOUNDS
                },
            ) {
                Err(error) => assert_eq!(
                    Some(error.code()),
                    case["error"].as_str(),
                    "{}",
                    case["name"]
                ),
                Ok(plan) => {
                    assert!(case["error"].is_null(), "{}", case["name"]);
                    assert_eq!(
                        plan.measurement().words as u64,
                        case["words"].as_u64().unwrap()
                    );
                    assert_eq!(
                        plan.measurement().policy_bytes as u64,
                        case["policy_bytes"].as_u64().unwrap()
                    );
                    assert_eq!(
                        serde_json::to_value(&plan.materialize()[0]).unwrap(),
                        case["decoded"]
                    );
                }
            }
        }
    }
    #[test]
    fn shared_style_vectors_match_the_exact_serialized_model() {
        let vectors: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        for case in vectors["styles"].as_array().unwrap() {
            let body: Styles = match serde_json::from_value(case["body"].clone()) {
                Ok(body) => body,
                Err(_) => {
                    assert_eq!(case["error"], "invalid_style", "{}", case["name"]);
                    continue;
                }
            };
            let result = body.validate(
                case["binding_slots"].as_u64().unwrap() as u32,
                case["context_count"].as_u64().unwrap() as usize,
            );
            if let Some(error) = case["error"].as_str() {
                assert_eq!(result.unwrap_err().code(), error);
            } else {
                result.unwrap();
                assert_eq!(serde_json::to_value(body).unwrap(), case["body"]);
            }
        }
    }
    #[test]
    fn preflight_covers_late_invalid_dictionaries_and_zero_word_records() {
        let valid = raw("[[0,1]]");
        let bad = raw("[[0,21]]");
        assert_eq!(
            ContextPlan::inspect(&[&valid, &bad], BOUNDS).err(),
            Some(Error::UnknownScope)
        );
        let empty = raw("[[0],[0],[0]]");
        assert_eq!(
            ContextPlan::inspect(
                &[&empty],
                Bounds {
                    max_bytes: 256,
                    ..BOUNDS
                }
            )
            .err(),
            Some(Error::ContextLimit)
        );
        assert_eq!(
            ContextPlan::inspect(
                &[&empty],
                Bounds {
                    max_bytes: 384,
                    ..BOUNDS
                }
            )
            .unwrap()
            .materialize()[0],
            vec![Vec::<u32>::new(), vec![], vec![]]
        );
    }
    #[test]
    fn numeric_identifiers_follow_js_value_semantics_without_rounding() {
        let part = raw("[[0.0,1e0],[1.0,2.0]]");
        assert_eq!(
            ContextPlan::inspect(&[&part], BOUNDS)
                .unwrap()
                .materialize()[0],
            vec![vec![1], vec![1, 2]]
        );
        for text in ["[[0,1.5]]", "[[0,-1]]", "[[0,4294967296]]", "[[0,null]]"] {
            assert_eq!(
                ContextPlan::inspect(&[&raw(text)], BOUNDS).err(),
                Some(Error::UnknownScope)
            );
        }
        for text in [
            "[[1]]",
            "[[]]",
            "[[0,1],[2]]",
            "[[0,1],null]",
            "[[0],[false]]",
        ] {
            assert_eq!(
                ContextPlan::inspect(&[&raw(text)], BOUNDS).err(),
                Some(Error::InvalidContext)
            );
        }
    }
}
