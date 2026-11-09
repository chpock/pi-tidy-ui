//! Portable style expressions and resolved values, independent of context admission.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StyleError {
    InvalidStyle,
}
impl StyleError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidStyle => "invalid_style",
        }
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
    pub fn validate(&self, binding_slots: u32) -> Result<(), StyleError> {
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
            return Err(StyleError::InvalidStyle);
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
    pub fn validate(&self, binding_slots: u32, contexts: usize) -> Result<(), StyleError> {
        let fingerprint = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if !fingerprint(&self.vocabulary)
            || !fingerprint(&self.rules)
            || self.indices.len() != contexts
        {
            return Err(StyleError::InvalidStyle);
        }
        let mut unique = HashSet::new();
        for style in &self.styles {
            style.validate(binding_slots)?;
            if !unique.insert(style) {
                return Err(StyleError::InvalidStyle);
            }
        }
        let valid_id = |&id: &u32| id > 0 && (id as usize) <= self.styles.len();
        if !self.indices.iter().all(valid_id) {
            return Err(StyleError::InvalidStyle);
        }
        let references: HashSet<_> = self.indices.iter().copied().collect();
        if references.len() != self.styles.len() {
            return Err(StyleError::InvalidStyle);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const VECTORS: &str = include_str!("../../../../protocol/syntax-v4/vectors.json");

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
}
