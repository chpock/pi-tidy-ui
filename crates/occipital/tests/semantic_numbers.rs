use occipital::semantic::{Bounds, ContextPlan};
use serde::Deserialize;
use serde_json::value::RawValue;

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    raw: String,
    error: Option<String>,
    value: Option<Vec<Vec<u32>>>,
}

#[test]
fn raw_context_numbers_have_the_same_binary64_meaning_as_the_client() {
    let vectors: Vectors = serde_json::from_str(include_str!(
        "../../../protocol/syntax-v3/context-number-vectors.json"
    ))
    .unwrap();
    for case in vectors.cases {
        let raw: Box<RawValue> = serde_json::from_str(&case.raw).unwrap();
        let result = ContextPlan::inspect(
            &[&raw],
            Bounds {
                vocabulary_size: 20,
                max_bytes: 1 << 20,
            },
        );
        if let Some(error) = case.error {
            assert_eq!(
                result.err().map(|e| e.code()),
                Some(error.as_str()),
                "{}",
                case.name
            );
        } else {
            assert_eq!(
                result.unwrap().materialize(),
                vec![case.value.unwrap()],
                "{}",
                case.name
            );
        }
    }
}
