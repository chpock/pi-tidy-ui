# Follow Pi palette plan — Oracle review and parent disposition

Status: **historical planning/mechanism review; findings incorporated; operator decisions A1–A4 approve the complete architecture, and A5 subsequently authorized implementation.** This document also records the later T3 role-policy correction and A7 decision. Product acceptance for the current role-derived correction is recorded in `.test-artifacts/follow-pi-role-derived/verification.md`; the original planning findings remain historical.

Planning baseline: `cefc6867c7f7897ce89a19640b482e2675795992`. Reviewed proposal: [follow-pi-palette-plan.md](follow-pi-palette-plan.md). During that planning review, runtime sources and tests were not changed. The operator requested a mechanism/readability review and a grill-for-unknowns pass before architecture decisions.

## Review identity and evidence

- Oracle first run: `40691c8b-504d-44ff-bdc7-bc9ec89f65b9`, read-only fork, completed.
- First full report: `.test-artifacts/follow-pi-implementation/review/oracle-planning.md`.
- Palette follow-up (first resume of the same Oracle session): `0cc1f0f8-cab4-4805-a208-445836920981`, completed. Full follow-up: `.test-artifacts/follow-pi-implementation/review/oracle-planning-follow-up.md`.
- Oracle freshly inspected current application/Rust/public Pi source. Parent independently reread `src/diff-palette.ts`, `src/syntax/{pi-palette,pi-bindings,pi-rules,card-layout,style-materialization,style-ansi}.ts`, `crates/occipital/src/resolver.rs`, the protocol contract and public theme/color implementations.
- Oracle's public Pi inspection used installed 1.3; parent separately checked project-installed 1.0. This establishes source evidence for these APIs, not completed runtime compatibility tests.
- No tests, builds, probes, screenshots, physical replay or performance acceptance were run for this planning task. Numeric color rules remain subject to visual calibration; no actual harmonious result is certified.

## Findings and verified disposition

### F1 — Optional shades were allowed to erase structural diff cues

**Confirmed design defect; fixed in plan.** The initial order derived subordinate inks against the panel and then constrained diff backgrounds by all derived inks. A shade near the contrast floor can unnecessarily force a useful diff tint back to the panel.

Evidence: `diff-palette.ts:26–59` contains per-ink contrast floors, bounded surface admission and panel fallback; `63–84` constructs code/gutter/sign constraints. `card-layout.ts:156–160,194–202` and `pi-palette.ts:8–14` show Bash title does not paint file diff rows.

Disposition: direct relevant file inks first; derive/freeze emitted diff surfaces; then fit optional variants to those surfaces, with exact-parent fallback. Remove Bash `toolTitle` from file diff constraints. Direct newly used semantic colors may reveal an existing readability problem; optional shades may not sacrifice structural tint. Keep one static potentially applicable file-role set, not per-visible-file scans.

### F2 — Raw authored OKLCH is not always the displayed parent

**Confirmed hidden mechanism issue; fixed in plan and confirmed in follow-up.** Public color provenance is sufficient, but authored out-of-gamut coordinates must not become the transformation origin before emission mapping.

Evidence: public `Theme` records concrete/default roles separately and approximates defaults/faint in `colors`; public prefixes expose exact direct ink/faint. TUI `colorToOklch` returns authored OKLCH unchanged; `colorToRgb` gamut-maps, while ANSI emission rounds/quantizes.

Disposition: public prefix is authoritative for direct ink/fonts. Use public concrete-kind provenance to distinguish authored indexed from quantized concrete colors; reject defaults/faint/authored-indexed for variants. Canonicalize to the effective emitted parent: sampled RGB in truecolor, sampled index through Pi's conventional extended-palette model only with proven concrete provenance in 256 mode. No private reads, guessed defaults, extra terminal queries, regenerated fallback or second normalization of direct ink. This verifies modeled, not arbitrary actual-terminal, colors.

### F3 — A universal softening transform demoted semantic peers

**Confirmed design overreach; fixed in plan.** The initial table used the same subordinate operation for parameters/options/language constants as for punctuation.

Disposition: only heading/string/inline-code/link delimiters receive optional subordinate variants. Commands use function, keys/attributes use variable, tag names/language constants use keyword; numbers retain number. Parameters/options/special shell variables deliberately share the authored variable family. Preserve the existing builtin/type family and comment/keyword subclass equivalences. Distinct parser labels do not require distinct colors.

Mechanism retained: fixed hue, neutral stays neutral, bounded lightness/chroma, no panel crossing, final-output contrast/DeltaE checks, deterministic ranking and exact-parent fallback. The original one-way 15-candidate calibration was superseded by T1 below and current plan section4.3. This is a bounded engineering policy, not a universal perceptual guarantee.

### F4 — Some semantic rows hid unsupported dynamic behavior

**Confirmed specification gap; fixed in plan.** A fixed generic binding cannot transform whichever enclosing semantic color later wins. "Semantic-family emphasis punctuation" and "stronger special variable color" were underspecified.

Evidence: `resolver.rs:81–107,324–369` chooses fixed property winners; `style-materialization.ts:20–28` binds foreground typography and then applies explicit masks, without a dynamic enclosing-color transform.

Disposition: emphasis delimiters inherit semantic foreground through exclusions from the broad punctuation foreground rule, verified against actual nested parser contexts. No family-by-nesting rule product or second matcher. Keep special shell variables in the variable family. Link delimiters clear underline only; retain meaningful enclosing bold/italic and established link-content underline.

### F5 — Quantized backgrounds also need final-output checking

**Confirmed acceptance gap; fixed in plan.** Existing contrast checks evaluate RGB surfaces before later mode conversion. New foreground checks alone cannot establish 256-color acceptance.

Evidence: `diff-palette.ts:35–55`, `pi-palette.ts:29–37`, `style-ansi.ts:12–24`.

Disposition: validate emitted known direct foreground/background pairs, including gutter/sign surfaces, before freezing them and fitting variants. Preserve authored direct inks; fall back to panel when a known emitted tint fails. Follow-up settled the nonnumeric policy: nonconcrete panel means no invented tint; each used hint also needs concrete provenance. Unknown/faint/authored-indexed foregrounds retain their exact representation, supply no guessed constraint, and do not automatically veto otherwise eligible tinting. Common faint gutter numbers thus do not erase all normal diff structure. Such surfaces have explicitly partial numeric coverage and require physical visual cases; unknown constraints are not passes.

### F6 — Visual calibration was too late; rejection stage wording was wrong

**Confirmed process/specification gaps; fixed in plan.** A formula can pass numeric checks while looking noisy. STYLE admission over existing contexts does not imply SOURCE has not previously run.

Disposition: add early test-only whole-source baseline/direct-only/related comparisons after pure preparation, before broad integration; retain actual CLI/replay final acceptance. Reject fragmented punctuation, demoted peers, lost structural cues and noise without scanning benefit. Assert trusted-selector rejection before interning/matching and no SOURCE caused by a STYLE rejection, not impossible SOURCE-before-STYLE ordering. No production comparison setting or temporary shipping phase.

## Remaining architecture and empirical boundaries

At the original two-pass review, Oracle supported the palette architecture after F1–F6 and left one operator-owned scope choice: actual strikethrough. Its recommended deferral is now **superseded by the operator's explicit 2026-10-21 inclusion decision**. The baseline mask is four bits; included work must explicitly revise the font contract, not silently expand it or imitate strike with color.

How strong the new shades should look is an empirical visual gate, not a request that the operator invent formulas. Direct default/faint/indexed limitations, fallback rates and exact whole-source results must be visible in implementation evidence. Approval of this plan does not claim runtime acceptance or authorize publication.

## Final follow-up disposition

Oracle freshly reread the revised plan and returned **ready for operator architecture approval after incorporating two exact policies**, with **no residual material contradictions**. Parent incorporated both in plan sections 4.2/4.4 and acceptance wording:

1. Effective emitted origin, exact sampled fallback and explicit conventional-palette limitation in 256 mode.
2. Concrete background/hint eligibility; enforcement of known emitted constraints; bounded tinting with explicit partial coverage for terminal-dependent foregrounds instead of blanket neutralization. Required physical/default/faint/indexed checks remain acceptance work, not waived tests.

Both are accepted technical choices, not operator questionnaire items. First-pass F1–F6 are all accepted and incorporated; none were rejected/deferred. The operator subsequently resolved A1 by including actual strike. Overall design approval remains pending; neither Oracle nor scope inclusion authorizes execution or implies visual acceptance.

## Operator scope addendum — actual strikethrough

Decision: actual Markdown strikethrough is included in the same Follow Pi change. Plan section 4.5/P1a now covers the fifth attribute bit, real SGR9/29 and reset isolation, Pi flat fallback/public-prefix preservation, native explicit full-clear, both-side validation/winners/accounting and versioned peer admission. Native profiles do not receive Follow Pi strike rules or altered authored colors.

Same-session Oracle consultation `42914683-7984-4027-acdc-71fbc473af8d` completed for this newly included scope. Full report: `.test-artifacts/follow-pi-implementation/review/oracle-font-contract.md`.

**Accepted technical recommendation:** keep protocol3/capability v3, require exactly resolver revision2, retain contexts/palette/client-definition structural revision1, and move all three effective fingerprint domains (client rules/native rules/native palette) to `/2`. Fifth bit16/full mask31 and five-winner/seven-score state apply consistently across Rust/TS. Native font replacements/full styles explicitly clear strike; native theme-definition fingerprints/colors remain unchanged. Common typography reset is `22;23;24;29`; emit SGR9 and preserve SGR9/29 through both public-prefix and Pi-flat consumers. Add actual pinned-parser nested/delimiter controls and matching/mismatched stdio/shared peer tests with zero STYLE admission for rejected revisions.

Parent verification: `semantic-protocol.ts:56–65` requires exact descriptor revisions; `provider.ts:464–476` decodes before accepting a candidate. `resolver.rs:305–319` funds the enlarged state through `size_of::<Scored>()`, so verify that existing calculation rather than inventing a separate allowance. Source validation/scorer/full masks, `style-ansi.ts` and `pi-flat.ts:211–229` confirm the coordinated changes are necessary. All recommendations are incorporated in plan section 4.5/P1a/validation.

**Disposition:** scope inclusion accepted as the operator's decision; technical mechanism accepted after source verification. No further operator scope question emerged. Original deferral is superseded, not left as optional implementation work. The complete design was subsequently approved in A4 below; no implementation, tests, runtime compatibility or physical strike acceptance is claimed. Published artifacts remain unchanged.

## Final operator architecture approval

The operator approved selective new shades for subordinate delimiters (A2), exact preservation of primary Pi colors even in low-contrast cases (A3), and then explicitly approved the final plan as a whole (A4). Actual Markdown strikethrough was already included by A1. The complete design includes updating the existing Follow Pi mode without another setting, retaining the current parser/resolver/painter boundaries, the explicit matching-helper/font-contract extension, and real visual/CLI/replay/independent-review gates.

This supersedes earlier references to pending overall approval; the dated review findings above remain historical. Approval was explicitly **without launching implementation**. No runtime code, product tests, shipping specs, commits, publication or acceptance results follow implicitly.

## Implementation feasibility correction T1

During A5 implementation, the parent measured actual builtin Pi1.0 inputs before relying on visual acceptance. All 15 one-way candidates failed in all eight dark/light family cases, including panel-only truecolor: dark parents had essentially no contrast headroom; light parents were already below 4.5. Both the original design and first reviews had missed a basic feasibility check. Safe fallback prevented damage but would have made the new shade feature inert on the common inputs.

Oracle was resumed read-only as `5a00c9ec-099e-4488-966b-a9b782d935d3`; the local report is `.test-artifacts/follow-pi-implementation/review/oracle-feasibility.md`. Parent verified the root cause and accepted the technical correction within operator-delegated formula work, without changing A2/A3: bounded bidirectional offsets including zero, 33 candidates, unchanged floor/distance/provenance/exact-parent fallback, rank by minimum necessary relative contrast increase then distance/chroma change. Low-contrast primary colors remain exact; only their separate delimiter may improve contrast. Fixed diff surfaces remain authoritative. Plan section4.3 explicitly supersedes the old formula. Feasibility is not visual/product acceptance; that evidence is recorded separately.


## T3 role-policy correction and A7 implementation

The T3 implementation interpreted role-specific treatment as a reason to stop deriving colors and borrow existing `syntaxPunctuation` ink for some markers. That removed the feature the operator had requested; its successful tests/review established only that this narrower behavior was internally consistent, not that it satisfied the palette-expansion goal. The operator rejected that result and restated the goal as A7 in `docs/follow-pi-palette-plan.md`.

The corrected contract derives missing structural inks from their own related public Pi roles, with independent neighbor/strength rules. In the current implementation, tiny heading markers derive from `mdHeading`; inline-code and link delimiters have separate restrained policies from `mdCode` and `mdLink`; direct `mdListBullet`, `mdQuoteBorder` and `mdCodeBlockBorder` roles remain their own roles; string delimiters remain the exact `syntaxString` color because a separate shade was not useful in the whole-source comparison. The current derived slots use the same Pi role for ink and original typography. If that role is faint, numeric derivation is rejected and the exact parent binding—including faint—is preserved; an unrelated faint punctuation role cannot donate either ink or typography. Primary content inks, typography ownership, provenance guards, fixed diff surfaces and exact-parent fallback remain intact. The `pi-marker-policy` regressions cover faint-parent and unrelated faint-role cases. See `docs/syntax-highlighting-spec.md#palette-and-geometry-independence` for the maintained contract.

Independent A7 source and visual reviews are complete. The source reviewer found no implementation issues. At normal generated-image size, the role-derived Gruvbox heading markers are clearly different from their heading text and stronger than weak T2/same-parent candidates; list bullets remain independent, and inline-code/link punctuation stays subordinate. The visual reviewer did not claim this is more conspicuous than the prior cream markers in the operator's screenshot, nor that a generated panel proves exact rendering in Foot. The panels use Cousine Nerd Font Mono at 24 px; real CLI tests verify emitted terminal cells in truecolor and 256-color modes, but no new graphical Foot capture was taken. Low-contrast themes remain poor and default/faint colors may correctly fall back unchanged. Full evidence and limitations: `.test-artifacts/follow-pi-role-derived/verification.md`.

The operator authorized this corrected implementation and documentation in A8. Current source review, whole-source visual comparison, test receipts and residual limitations are recorded in `.test-artifacts/follow-pi-role-derived/verification.md`; the historical T3 review is not acceptance evidence for A7.
