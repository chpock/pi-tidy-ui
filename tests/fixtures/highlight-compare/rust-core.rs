#![allow(dead_code)]

//! Independently authored Rust 2024 syntax contexts.

use std::fmt::Debug;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct Point<'a> {
    label: &'a str,
    coordinates: (i32, i32),
}

pub trait Measure<T> {
    fn measure(&self, value: T) -> usize;
}

impl<T: AsRef<str>> Measure<T> for Point<'_> {
    fn measure(&self, value: T) -> usize {
        self.label.len() + value.as_ref().len()
    }
}

macro_rules! choose {
    ($value:expr, $fallback:expr) => {
        $value.unwrap_or($fallback)
    };
}

pub async fn describe<T: Debug>(value: T) -> String {
    format!("value={value:?}")
}

pub async fn count_result() -> Result<usize, &'static str> {
    Ok(3)
}

pub async fn label_count() -> Result<String, &'static str> {
    let count = count_result().await?;
    let Some(value) = Some(count) else { return Err("missing count"); };
    Ok(format!("count={value}"))
}

pub fn classify(value: Option<Point<'_>>) -> &'static str {
    match value {
        Some(Point { coordinates: (0, y), .. }) if y > 0 => "vertical",
        Some(Point { coordinates: (x, _), .. }) if x < 0 => "negative",
        Some(_) => "point",
        None => "empty",
    }
}

pub fn literals() -> (&'static str, &'static str, [u8; 2], char, i64) {
    let escaped = "line one\nline two\t\"quoted\"";
    let raw = r#"raw "quoted" text\path"#;
    let bytes = *b"OK";
    let letter = '界';
    let number = 0x2A_i64 + 0o10 + 0b10_0000;
    (escaped, raw, bytes, letter, number)
}

pub unsafe fn read_first(pointer: *const u8) -> Option<u8> {
    unsafe { pointer.as_ref().copied() }
}

pub fn r#gen() -> impl Iterator<Item = usize> {
    (0..3).map(|value| value * 2)
}
