//! Borrowed, pre-intern admission and identity for generic client rule definitions.
//! RawValue capture/frame buffering and serde_json's lexical/unescape/error scratch
//! precede controlled compilation; the reservation is not a decoder/private-heap
//! RSS cap. Decoder diagnostics are discarded, never returned as caller text.
use crate::{
    resolver::{AttributePatch, Resolver, Rule},
    semantic::{Expression, Ink},
    vocabulary::ScopeId,
};
use serde::{
    de::{self, SeqAccess, Visitor},
    Deserialize,
};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{fmt, mem::size_of};
use syntect::{
    highlighting::ScopeSelector,
    parsing::{Scope, ScopeStack},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidRules,
    UnknownScope,
    RuleLimit,
    AllocationLimit,
}
impl Error {
    /// Every failure is before source work and before any selector/scope materialization.
    pub fn fault(self) -> crate::protocol::Fault {
        crate::protocol::Fault::not_started(match self {
            Self::UnknownScope => "unknown_scope",
            Self::AllocationLimit => "data_limit",
            Self::InvalidRules | Self::RuleLimit => "invalid_rules",
        })
    }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Measurement {
    pub rules: usize,
    pub paths: usize,
    pub names: usize,
    pub name_bytes: usize,
    pub atoms: usize,
    /// Controlled compile peak allowance, not wire bytes, lexical scratch or RSS.
    pub policy_bytes: usize,
}
// All required fields stay raw, including required nullable fields. In particular,
// Option<Ink> would conflate missing/null and internally tagged Ink would buffer Content.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition<'a> {
    #[serde(borrow)]
    revision: &'a RawValue,
    #[serde(borrow)]
    binding_slots: &'a RawValue,
    #[serde(borrow)]
    default: &'a RawValue,
    #[serde(borrow)]
    rules: &'a RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Declaration<'a> {
    #[serde(borrow)]
    path: &'a RawValue,
    #[serde(borrow)]
    excludes: &'a RawValue,
    #[serde(borrow)]
    foreground: &'a RawValue,
    #[serde(borrow)]
    background: &'a RawValue,
    #[serde(borrow)]
    font: &'a RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawExpression<'a> {
    #[serde(borrow)]
    foreground: &'a RawValue,
    #[serde(borrow)]
    background: &'a RawValue,
    #[serde(borrow)]
    attributes: &'a RawValue,
    #[serde(borrow)]
    attribute_mask: &'a RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Font<'a> {
    #[serde(borrow)]
    attributes: &'a RawValue,
    #[serde(borrow)]
    attribute_mask: &'a RawValue,
}
fn present<'de, D: de::Deserializer<'de>>(d: D) -> Result<Option<&'de RawValue>, D::Error> {
    <&RawValue>::deserialize(d).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawInk<'a> {
    #[serde(borrow)]
    kind: &'a RawValue,
    #[serde(borrow, default, deserialize_with = "present")]
    r: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    g: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    b: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    index: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    slot: Option<&'a RawValue>,
}
fn decode<'a, T: Deserialize<'a>>(raw: &'a RawValue) -> Result<T, Error> {
    // Serde structs otherwise also accept positional JSON arrays.
    if !raw.get().trim_start().starts_with('{') {
        return Err(Error::InvalidRules);
    }
    serde_json::from_str(raw.get()).map_err(|_| Error::InvalidRules)
}
fn unsigned(raw: &RawValue, max: u32) -> Result<u32, Error> {
    // RawValue already guarantees valid JSON. Parse the complete numeric token:
    // serde_json without float_roundtrip can round a fractional token to an integer.
    let n = raw
        .get()
        .trim()
        .parse::<f64>()
        .map_err(|_| Error::InvalidRules)?;
    if n.is_finite() && n >= 0.0 && n <= f64::from(max) && n.fract() == 0.0 {
        Ok(n as u32)
    } else {
        Err(Error::InvalidRules)
    }
}
// Small scalar/sequence visitors stream decoded names and borrowed array entries;
// they never construct owned name arrays or a general JSON value tree.
fn string<T>(raw: &RawValue, mut f: impl FnMut(&str) -> Result<T, Error>) -> Result<T, Error> {
    struct Text<'a, F>(&'a mut F, &'a mut Option<Error>);
    impl<'de, T, F: FnMut(&str) -> Result<T, Error>> Visitor<'de> for Text<'_, F> {
        type Value = T;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("string")
        }
        fn visit_str<E: de::Error>(self, text: &str) -> Result<T, E> {
            (self.0)(text).map_err(|e| {
                *self.1 = Some(e);
                E::custom("invalid rule string")
            })
        }
    }
    let mut failure = None;
    let mut decoder = serde_json::Deserializer::from_str(raw.get());
    de::Deserializer::deserialize_str(&mut decoder, Text(&mut f, &mut failure))
        .map_err(|_| failure.unwrap_or(Error::InvalidRules))
}
fn array<'a>(
    raw: &'a RawValue,
    mut f: impl FnMut(&'a RawValue) -> Result<(), Error>,
) -> Result<usize, Error> {
    struct Entries<'a, F>(&'a mut F, &'a mut Option<Error>);
    impl<'de, F: FnMut(&'de RawValue) -> Result<(), Error>> Visitor<'de> for Entries<'_, F> {
        type Value = usize;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("array")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<usize, A::Error> {
            let mut count = 0;
            while let Some(raw) = seq.next_element::<&RawValue>()? {
                (self.0)(raw).map_err(|e| {
                    *self.1 = Some(e);
                    de::Error::custom("invalid rule entry")
                })?;
                count += 1;
            }
            Ok(count)
        }
    }
    let mut failure = None;
    let mut decoder = serde_json::Deserializer::from_str(raw.get());
    de::Deserializer::deserialize_seq(&mut decoder, Entries(&mut f, &mut failure))
        .map_err(|_| failure.unwrap_or(Error::InvalidRules))
}
fn ink(raw: &RawValue, slots: u32) -> Result<Ink, Error> {
    let value: RawInk<'_> = decode(raw)?;
    let fields = [value.r, value.g, value.b, value.index, value.slot];
    string(value.kind, |kind| {
        let mask = match kind {
            "rgb" => 7,
            "indexed" => 8,
            "binding" => 16,
            "terminal-default" | "inherit" => 0,
            _ => return Err(Error::InvalidRules),
        };
        if fields
            .iter()
            .enumerate()
            .any(|(i, v)| v.is_some() != (mask & (1 << i) != 0))
        {
            return Err(Error::InvalidRules);
        }
        let byte = |i: usize| unsigned(fields[i].unwrap(), 255).map(|n| n as u8);
        Ok(match kind {
            "rgb" => Ink::Rgb {
                r: byte(0)?,
                g: byte(1)?,
                b: byte(2)?,
            },
            "indexed" => Ink::Indexed { index: byte(3)? },
            "binding" => {
                let slot = unsigned(value.slot.unwrap(), u16::MAX.into())?;
                if slot >= slots {
                    return Err(Error::InvalidRules);
                }
                Ink::Binding { slot: slot as u16 }
            }
            "terminal-default" => Ink::TerminalDefault {},
            "inherit" => Ink::Inherit {},
            _ => unreachable!(),
        })
    })
}
fn font(raw: &RawValue) -> Result<AttributePatch, Error> {
    let value: Font<'_> = decode(raw)?;
    let value_bits = unsigned(value.attributes, 31)? as u8;
    let mask = unsigned(value.attribute_mask, 31)? as u8;
    if value_bits & !mask != 0 {
        return Err(Error::InvalidRules);
    }
    Ok(AttributePatch {
        value: value_bits,
        mask,
    })
}
fn expression(raw: &RawValue, slots: u32) -> Result<Expression, Error> {
    let value: RawExpression<'_> = decode(raw)?;
    let result = Expression {
        foreground: ink(value.foreground, slots)?,
        background: ink(value.background, slots)?,
        attributes: unsigned(value.attributes, 31)? as u8,
        attribute_mask: unsigned(value.attribute_mask, 31)? as u8,
    };
    result
        .validate(false, slots)
        .map_err(|_| Error::InvalidRules)?;
    Ok(result)
}
struct Overrides {
    foreground: Option<Ink>,
    background: Option<Ink>,
    attributes: Option<AttributePatch>,
}
fn overrides(value: &Declaration<'_>, slots: u32) -> Result<Overrides, Error> {
    let color = |raw: &RawValue| {
        if raw.get() == "null" {
            Ok(None)
        } else {
            ink(raw, slots).map(Some)
        }
    };
    Ok(Overrides {
        foreground: color(value.foreground)?,
        background: color(value.background)?,
        attributes: if value.font.get() == "null" {
            None
        } else {
            Some(font(value.font)?)
        },
    })
}
fn increment(total: &mut usize, n: usize, limit: usize) -> Result<(), Error> {
    *total = total
        .checked_add(n)
        .filter(|v| *v <= limit)
        .ok_or(Error::RuleLimit)?;
    Ok(())
}
impl Measurement {
    fn path(&mut self, raw: &RawValue) -> Result<(), Error> {
        let limits = crate::admission::Limits::default();
        increment(&mut self.paths, 1, crate::profile::THEME_PATHS)?;
        array(raw, |raw| {
            string(raw, |name| {
                if name.is_empty() || name.chars().any(|c| c.is_whitespace() || c.is_control()) {
                    return Err(Error::InvalidRules);
                }
                let atoms = name.trim_end_matches('.').split('.').count();
                if atoms > 8 {
                    return Err(Error::RuleLimit);
                }
                increment(&mut self.name_bytes, name.len(), limits.selector_bytes)?;
                increment(&mut self.atoms, atoms, limits.atom_occurrences)?;
                self.names += 1;
                ScopeId::from_name(name).ok_or(Error::UnknownScope)?;
                Ok(())
            })
        })?;
        Ok(())
    }
    fn allocation(&self) -> Result<usize, Error> {
        // Frozen Resolver::compile moves the input Vec into two geometrically grown
        // partitions and stable-sorts singles. Eight largest-record copies per rule
        // (minimum capacity four) cover input, partitions/reallocation and sort scratch.
        // Path records/words are additionally charged; decoder scratch and the finite
        // once-initialized grammar vocabulary repository are separate asset costs.
        self.rules
            .max(4)
            .checked_mul(8)
            .and_then(|n| n.checked_mul(size_of::<(Scope, usize, Rule)>()))
            .and_then(|n| {
                self.paths
                    .checked_mul(size_of::<ScopeStack>())
                    .and_then(|m| n.checked_add(m))
            })
            .and_then(|n| {
                self.names
                    .checked_mul(size_of::<Scope>())
                    .and_then(|m| n.checked_add(m))
            })
            .and_then(|n| n.checked_add(size_of::<ClientRulePlan<'_>>() + 64))
            .ok_or(Error::AllocationLimit)
    }
}

pub struct ClientRulePlan<'a> {
    definition: Definition<'a>,
    slots: u32,
    measurement: Measurement,
    fingerprint: String,
}
impl<'a> ClientRulePlan<'a> {
    /// Inspect the entire immutable definition before selectors, ScopeStacks, owned
    /// name arrays or process-local scope handles exist. The caller reserves the
    /// reported policy_bytes before compile; available_bytes is its current credit.
    pub fn inspect(raw: &'a RawValue, available_bytes: usize) -> Result<Self, Error> {
        if raw.get().len() > crate::limits::WIRE_BYTES {
            return Err(Error::RuleLimit);
        }
        let definition: Definition<'a> = decode(raw)?;
        if unsigned(definition.revision, 1)? != 1 {
            return Err(Error::InvalidRules);
        }
        let slots = unsigned(definition.binding_slots, 65536)?;
        expression(definition.default, slots)?;
        let mut measurement = Measurement::default();
        array(definition.rules, |raw| {
            increment(&mut measurement.rules, 1, crate::profile::THEME_SELECTORS)?;
            let value: Declaration<'_> = decode(raw)?;
            measurement.path(value.path)?;
            array(value.excludes, |path| measurement.path(path))?;
            overrides(&value, slots)?;
            Ok(())
        })?;
        measurement.policy_bytes = measurement.allocation()?;
        if measurement.policy_bytes > available_bytes {
            return Err(Error::AllocationLimit);
        }
        let fingerprint = fingerprint(&definition, slots, measurement.rules)?;
        Ok(Self {
            definition,
            slots,
            measurement,
            fingerprint,
        })
    }
    pub fn measurement(&self) -> Measurement {
        self.measurement
    }
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    /// Consumes a fully admitted borrowed plan; this does not acquire job/byte credit.
    pub fn compile(self) -> Resolver {
        let path = |raw: &RawValue| -> Result<ScopeStack, Error> {
            let count = array(raw, |_| Ok(()))?;
            let mut scopes = Vec::with_capacity(count);
            array(raw, |raw| {
                string(raw, |name| {
                    scopes.push(
                        ScopeId::from_name(name)
                            .expect("preflighted immutable name")
                            .scope(),
                    );
                    Ok(())
                })
            })?;
            Ok(ScopeStack::from_vec(scopes))
        };
        let mut rules = Vec::with_capacity(self.measurement.rules);
        array(self.definition.rules, |raw| {
            let value: Declaration<'_> = decode(raw)?;
            let mut excludes = Vec::with_capacity(array(value.excludes, |_| Ok(()))?);
            array(value.excludes, |raw| {
                excludes.push(path(raw)?);
                Ok(())
            })?;
            let Overrides {
                foreground,
                background,
                attributes,
            } = overrides(&value, self.slots)?;
            rules.push(Rule {
                selector: ScopeSelector {
                    path: path(value.path)?,
                    excludes,
                },
                foreground,
                background,
                attributes,
            });
            Ok(())
        })
        .expect("immutable preflighted rules");
        Resolver::compile(
            expression(self.definition.default, self.slots).expect("immutable preflighted default"),
            rules,
        )
    }
}

fn ink_key(ink: &Ink) -> String {
    match ink {
        Ink::Rgb { r, g, b } => format!("r{r},{g},{b}"),
        Ink::Indexed { index } => format!("i{index}"),
        Ink::TerminalDefault {} => "d".into(),
        Ink::Binding { slot } => format!("b{slot}"),
        Ink::Inherit {} => "h".into(),
    }
}
fn expression_key(value: &Expression) -> String {
    format!(
        "{}/{}/{}/{}",
        ink_key(&value.foreground),
        ink_key(&value.background),
        value.attributes,
        value.attribute_mask
    )
}
fn number(hash: &mut Sha256, n: usize) {
    hash.update((n as u32).to_be_bytes());
}
fn text(hash: &mut Sha256, text: &str) {
    number(hash, text.len());
    hash.update(text.as_bytes());
}
fn hash_path(hash: &mut Sha256, raw: &RawValue) -> Result<(), Error> {
    number(hash, array(raw, |_| Ok(()))?);
    array(raw, |raw| {
        string(raw, |name| {
            text(hash, name);
            Ok(())
        })
    })?;
    Ok(())
}
fn fingerprint(definition: &Definition<'_>, slots: u32, rules: usize) -> Result<String, Error> {
    let mut hash = Sha256::new();
    hash.update(b"occipital-client-rules/2\0");
    number(&mut hash, slots as usize);
    text(
        &mut hash,
        &expression_key(&expression(definition.default, slots)?),
    );
    number(&mut hash, rules);
    array(definition.rules, |raw| {
        let value: Declaration<'_> = decode(raw)?;
        hash_path(&mut hash, value.path)?;
        number(&mut hash, array(value.excludes, |_| Ok(()))?);
        array(value.excludes, |raw| hash_path(&mut hash, raw))?;
        let Overrides {
            foreground: fg,
            background: bg,
            attributes: font,
        } = overrides(&value, slots)?;
        hash.update([u8::from(fg.is_some())
            | (u8::from(bg.is_some()) << 1)
            | (u8::from(font.is_some()) << 2)]);
        text(
            &mut hash,
            &expression_key(&Expression {
                foreground: fg.unwrap_or(Ink::Inherit {}),
                background: bg.unwrap_or(Ink::Inherit {}),
                attributes: font.map_or(0, |f| f.value),
                attribute_mask: font.map_or(0, |f| f.mask),
            }),
        );
        Ok(())
    })?;
    Ok(format!("{:x}", hash.finalize()))
}
fn native_identity(domain: &[u8], definition: &str) -> Result<String, Error> {
    if definition.len() != 64
        || !definition
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::InvalidRules);
    }
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update([0]);
    hash.update(definition.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}
pub fn fingerprint_native_rules(definition: &str) -> Result<String, Error> {
    native_identity(b"occipital-native-rules/2", definition)
}
pub fn fingerprint_native_palette(definition: &str) -> Result<String, Error> {
    native_identity(b"occipital-native-palette/2", definition)
}
