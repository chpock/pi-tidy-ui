//! Finite bundled-profile structural calibration; no runtime instrumentation.
use serde_json::json;
use two_face::theme::{EmbeddedLazyThemeSet, LazyThemeSet};
fn main() {
    let themes: LazyThemeSet = two_face::theme::extra().into();
    let mut rows = Vec::new();
    for name in EmbeddedLazyThemeSet::theme_names() {
        let theme = themes.get(name.as_name()).unwrap();
        let (mut selectors, mut paths, mut terms) = (0usize, 0usize, 0usize);
        for item in &theme.scopes {
            for selector in &item.scope.selectors {
                selectors += 1;
                paths += 1 + selector.excludes.len();
                terms += selector.path.len();
                for exclude in &selector.excludes {
                    terms += exclude.len();
                }
            }
        }
        rows.push(json!({"name":name.as_name(),"items":theme.scopes.len(),"selectors":selectors,"paths":paths,"terms":terms}));
    }
    println!("{}", serde_json::to_string_pretty(&rows).unwrap());
}
