//! Borrowed context preflight and funded expansion into trusted vocabulary IDs.
use crate::limits::{CONTEXT_ROW_UNITS as ROW_UNITS, CONTEXT_WORD_UNITS as WORD_UNITS};
use serde::{de, de::DeserializeSeed};
use serde_json::value::RawValue;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidContext,
    UnknownScope,
    ContextLimit,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidContext => "invalid_context",
            Self::UnknownScope => "unknown_scope",
            Self::ContextLimit => "context_limit",
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
        if raw.len() > crate::limits::BATCH_SOURCES
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

#[cfg(test)]
mod tests {
    use super::*;
    const VECTORS: &str = include_str!("../../../../protocol/syntax-v4/vectors.json");
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
