//! Shared failure code and evidence of whether computation started.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fault {
    pub code: &'static str,
    pub started: bool,
}

impl Fault {
    pub fn not_started(code: &'static str) -> Self {
        Self {
            code,
            started: false,
        }
    }
    pub fn started(code: &'static str) -> Self {
        Self {
            code,
            started: true,
        }
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for Fault {}
