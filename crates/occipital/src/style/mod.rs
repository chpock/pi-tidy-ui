//! Portable style values, bounded context/rule admission and generic matching.
pub mod contexts;
mod model;
pub mod request;
pub mod resolver;
pub mod rules;
mod work;

pub use model::{Expression, Ink, StyleError, StyleKind, Styles};
pub use work::{StyleFailure, StyleWork};
