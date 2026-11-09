use occipital::style::{
    contexts::{Bounds, ContextPlan, Error as ContextError},
    Expression, Ink, StyleError,
};
use serde_json::value::RawValue;

fn style_error_code(error: StyleError) -> &'static str {
    match error {
        StyleError::InvalidStyle => error.code(),
    }
}

fn context_error_code(error: ContextError) -> &'static str {
    match error {
        ContextError::InvalidContext | ContextError::UnknownScope | ContextError::ContextLimit => {
            error.code()
        }
    }
}

#[test]
fn context_and_value_validation_expose_only_their_own_failure_domains() {
    let expression = Expression {
        foreground: Ink::Inherit {},
        background: Ink::Inherit {},
        attributes: 32,
        attribute_mask: 31,
    };
    assert_eq!(
        style_error_code(expression.validate(0).unwrap_err()),
        "invalid_style"
    );

    let raw = RawValue::from_string("[[0,2]]".into()).unwrap();
    let error = ContextPlan::inspect(
        &[&raw],
        Bounds {
            vocabulary_size: 1,
            max_bytes: 1 << 20,
        },
    )
    .err()
    .unwrap();
    assert_eq!(context_error_code(error), "unknown_scope");
}
