//! Theme-independent parser continuation. Reply dictionaries never live in idle leases.
//! Syntect's private parser/lexer heaps and its transient operation Vec are outside
//! controlled allocation policy. The latter is measured and dropped within each line call.
use crate::{
    protocol::{Counters, Fault, SyntaxHint},
    vocabulary::ScopeId,
};
use std::{collections::hash_map::RandomState, hash::BuildHasher, mem::size_of, sync::OnceLock};
use syntect::parsing::{
    ClearAmount, ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet,
};

#[derive(Clone, Debug)]
pub struct Limits {
    pub source_bytes: usize,
    pub line_bytes: usize,
    pub leases: usize,
    pub per_scope: usize,
    pub state_pool_bytes: usize,
    pub runs: usize,
    pub quantum_ms: u64,
    pub idle_ms: u64,
    pub age_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            source_bytes: crate::limits::SOURCE_BYTES,
            line_bytes: crate::request::LINE_BYTES,
            leases: crate::limits::LEASES,
            per_scope: crate::limits::LEASES_PER_ROUTE,
            state_pool_bytes: crate::limits::STATE_BYTES,
            runs: crate::limits::RUNS,
            quantum_ms: 2,
            idle_ms: crate::limits::IDLE_MS,
            age_ms: crate::limits::AGE_MS,
        }
    }
}
/// Opaque parser incarnation, independent of the service's wire lease/generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Lease(u64);
#[derive(Debug)]
pub struct SourceChunk {
    pub revision: u32,
    pub source_bytes: u32,
    pub committed_bytes: u32,
    pub replace_from: u32,
    /// Front-coded reply-local rows. Positive run IDs are one-based positions here.
    pub contexts: Vec<Vec<u32>>,
    /// [positive byte length, reply-local context ID]; zero means unclassified.
    pub runs: Vec<[u32; 2]>,
    pub counters: Counters,
}
#[derive(Default)]
struct Budget {
    held: usize,
    peak: usize,
}
impl Budget {
    fn add(&mut self, bytes: usize, reserve: &mut dyn FnMut(usize) -> bool) -> Result<(), Fault> {
        let required = self
            .held
            .checked_add(bytes)
            .ok_or(Fault::not_started("data_limit"))?;
        if required > self.peak {
            if !reserve(required) {
                return Err(Fault::not_started("data_limit"));
            }
            self.peak = required;
        }
        self.held = required;
        Ok(())
    }
    fn release(&mut self, bytes: usize) {
        self.held = self
            .held
            .checked_sub(bytes)
            .expect("controlled ownership accounting");
    }
}
fn bytes<T>(count: usize) -> Result<usize, Fault> {
    count
        .checked_mul(size_of::<T>())
        .ok_or(Fault::not_started("data_limit"))
}
fn grow<T>(
    v: &mut Vec<T>,
    needed: usize,
    b: &mut Budget,
    reserve: &mut dyn FnMut(usize) -> bool,
) -> Result<(), Fault> {
    if needed <= v.capacity() {
        return Ok(());
    }
    let cap = needed
        .max(
            v.capacity()
                .checked_mul(2)
                .ok_or(Fault::not_started("data_limit"))?,
        )
        .max(4);
    b.add(bytes::<T>(cap)?, reserve)?;
    let old = bytes::<T>(v.capacity())?;
    v.try_reserve_exact(cap - v.len())
        .map_err(|_| Fault::not_started("data_limit"))?;
    b.release(old);
    Ok(())
}
fn append_text(
    text: &mut String,
    part: &str,
    b: &mut Budget,
    reserve: &mut dyn FnMut(usize) -> bool,
) -> Result<(), Fault> {
    let needed = text
        .len()
        .checked_add(part.len())
        .ok_or(Fault::not_started("data_limit"))?;
    if needed > text.capacity() {
        let cap = needed
            .max(
                text.capacity()
                    .checked_mul(2)
                    .ok_or(Fault::not_started("data_limit"))?,
            )
            .max(4);
        b.add(cap, reserve)?;
        let old = text.capacity();
        text.try_reserve_exact(cap - text.len())
            .map_err(|_| Fault::not_started("data_limit"))?;
        b.release(old);
    }
    text.push_str(part);
    Ok(())
}
// Track native Clear/Restore containers as well as the exposed active scope Vec.
// Their depth is the established native256 guard, not a new context-table cap.
struct Stack {
    native: ScopeStack,
    cleared: Vec<(usize, usize)>,
    count: usize,
    header_cap: usize,
}
impl Stack {
    fn new() -> Self {
        Self {
            native: ScopeStack::new(),
            cleared: Vec::new(),
            count: 0,
            header_cap: 0,
        }
    }
    fn dynamic_bytes(&self) -> usize {
        self.native.scopes.capacity() * size_of::<Scope>()
            + self.cleared.capacity() * size_of::<(usize, usize)>()
            + self.header_cap * size_of::<Vec<Scope>>()
            + self.cleared[..self.count]
                .iter()
                .map(|(_, cap)| cap * size_of::<Scope>())
                .sum::<usize>()
    }
    fn preview(
        &self,
        b: &mut Budget,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<Self, Fault> {
        let dynamic = self.native.len() * size_of::<Scope>()
            + self.count * size_of::<(usize, usize)>()
            + self.count * size_of::<Vec<Scope>>()
            + self.cleared[..self.count]
                .iter()
                .map(|(len, _)| len * size_of::<Scope>())
                .sum::<usize>();
        b.add(dynamic, reserve)?;
        let mut cleared = self.cleared.clone();
        for item in &mut cleared[..self.count] {
            item.1 = item.0;
        }
        Ok(Self {
            native: self.native.clone(),
            cleared,
            count: self.count,
            header_cap: self.count,
        })
    }
    fn apply(
        &mut self,
        op: &ScopeStackOp,
        b: &mut Budget,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<(), Fault> {
        let mut old_headers = 0;
        match op {
            ScopeStackOp::Push(scope) => {
                if ScopeId::from_scope(*scope).is_none() {
                    return Err(Fault::started("vocabulary_mismatch"));
                }
                if self.native.len() == 256 {
                    return Err(Fault::started("scope_limit"));
                }
                let needed = self.native.len() + 1;
                grow(&mut self.native.scopes, needed, b, reserve)?;
            }
            ScopeStackOp::Clear(amount) => {
                if self.count == 256 {
                    return Err(Fault::started("scope_limit"));
                }
                grow(&mut self.cleared, self.count + 1, b, reserve)?;
                if self.count == self.header_cap {
                    let cap = (self.header_cap * 2).max(4);
                    b.add(cap * size_of::<Vec<Scope>>(), reserve)?;
                    old_headers = self.header_cap * size_of::<Vec<Scope>>();
                    self.header_cap = cap;
                }
                let (len, cap) = match amount {
                    ClearAmount::All => (self.native.len(), self.native.scopes.capacity()),
                    ClearAmount::TopN(n) => {
                        let len = (*n).min(self.native.len());
                        b.add(len * size_of::<Scope>(), reserve)?;
                        (len, len)
                    }
                };
                self.cleared.push((len, cap));
                self.count += 1;
            }
            ScopeStackOp::Restore => {
                if self.count == 0 {
                    return Err(Fault::started("parser_error"));
                }
                let needed = self.native.len() + self.cleared[self.count - 1].0;
                if needed > 256 {
                    return Err(Fault::started("scope_limit"));
                }
                grow(&mut self.native.scopes, needed, b, reserve)?;
            }
            _ => {}
        }
        self.native
            .apply(op)
            .map_err(|_| Fault::started("parser_error"))?;
        b.release(old_headers);
        if matches!(op, ScopeStackOp::Restore) {
            self.count -= 1;
            b.release(self.cleared.pop().unwrap().1 * size_of::<Scope>());
        }
        Ok(())
    }
}
#[derive(Default)]
struct Window {
    paths: Vec<Vec<u32>>,
    runs: Vec<[u32; 2]>,
}
impl Window {
    fn dynamic_bytes(&self) -> usize {
        self.paths.capacity() * size_of::<Vec<u32>>()
            + self.paths.iter().map(|p| p.capacity() * 4).sum::<usize>()
            + self.runs.capacity() * 8
    }
}
struct Emitter {
    window: Window,
    rows: Vec<Vec<u32>>,
    indices: Vec<u32>,
    hash: RandomState,
    words: usize,
    decoded_bytes: usize,
    max_words: usize,
    max_decoded_bytes: usize,
}
impl Default for Emitter {
    fn default() -> Self {
        Self {
            window: Window::default(),
            rows: Vec::new(),
            indices: Vec::new(),
            hash: RandomState::new(),
            words: 0,
            decoded_bytes: crate::limits::SOURCE_UNITS,
            max_words: crate::limits::CONTEXT_WORDS,
            max_decoded_bytes: crate::limits::DECODED_BYTES - crate::limits::SOURCE_BODY_UNITS,
        }
    }
}
impl Emitter {
    fn charge_result(&mut self, words: usize, bytes: usize) -> Result<(), Fault> {
        let words = self
            .words
            .checked_add(words)
            .filter(|&n| n <= self.max_words)
            .ok_or(Fault::started("context_limit"))?;
        let bytes = self
            .decoded_bytes
            .checked_add(bytes)
            .filter(|&n| n <= self.max_decoded_bytes)
            .ok_or(Fault::started("result_limit"))?;
        self.words = words;
        self.decoded_bytes = bytes;
        Ok(())
    }
    fn bucket(&self, path: &[u32]) -> usize {
        self.hash.hash_one(path) as usize & (self.indices.len() - 1)
    }
    fn context(
        &mut self,
        path: &[u32],
        b: &mut Budget,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<u32, Fault> {
        if !self.indices.is_empty() {
            let mut index = self.bucket(path);
            while self.indices[index] != 0 {
                let id = self.indices[index];
                if self.window.paths[id as usize - 1] == path {
                    return Ok(id);
                }
                index = (index + 1) & (self.indices.len() - 1);
            }
        }
        self.charge_result(
            path.len(),
            crate::limits::CONTEXT_ROW_UNITS + path.len() * crate::limits::CONTEXT_WORD_UNITS,
        )?;
        let count = self.window.paths.len() + 1;
        let id = u32::try_from(count).map_err(|_| Fault::started("result_limit"))?;
        if self.indices.len() < count.checked_mul(2).ok_or(Fault::started("data_limit"))? {
            let cap = self
                .indices
                .len()
                .checked_mul(2)
                .ok_or(Fault::started("data_limit"))?
                .max(8);
            b.add(bytes::<u32>(cap)?, reserve)?;
            let mut indices = vec![0; cap];
            for (n, path) in self.window.paths.iter().enumerate() {
                let mut index = self.hash.hash_one(path) as usize & (cap - 1);
                while indices[index] != 0 {
                    index = (index + 1) & (cap - 1);
                }
                indices[index] = n as u32 + 1;
            }
            b.release(self.indices.capacity() * 4);
            self.indices = indices;
        }
        grow(&mut self.window.paths, count, b, reserve)?;
        grow(&mut self.rows, count, b, reserve)?;
        let previous = self.window.paths.last().map_or(&[][..], Vec::as_slice);
        let prefix = previous
            .iter()
            .zip(path)
            .take_while(|(a, b)| a == b)
            .count();
        let row_len = 1 + path.len() - prefix;
        b.add(
            bytes::<u32>(
                path.len()
                    .checked_add(row_len)
                    .ok_or(Fault::started("data_limit"))?,
            )?,
            reserve,
        )?;
        let mut row = Vec::with_capacity(row_len);
        row.push(prefix as u32);
        row.extend_from_slice(&path[prefix..]);
        let index = self.bucket(path);
        let mut index = index;
        while self.indices[index] != 0 {
            index = (index + 1) & (self.indices.len() - 1);
        }
        self.indices[index] = id;
        self.rows.push(row);
        self.window.paths.push(path.to_vec());
        Ok(id)
    }
    fn span(
        &mut self,
        length: usize,
        id: u32,
        cap: usize,
        b: &mut Budget,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<(), Fault> {
        if length == 0 {
            return Ok(());
        }
        let length = u32::try_from(length).map_err(|_| Fault::started("result_limit"))?;
        if let Some(last) = self.window.runs.last_mut() {
            if last[1] == id {
                last[0] = last[0]
                    .checked_add(length)
                    .ok_or(Fault::started("result_limit"))?;
                return Ok(());
            }
        }
        if self.window.runs.len() >= cap {
            return Err(Fault::started("result_limit"));
        }
        self.charge_result(0, 8)?;
        let needed = self.window.runs.len() + 1;
        grow(&mut self.window.runs, needed, b, reserve)?;
        self.window.runs.push([length, id]);
        Ok(())
    }
    fn parsed_span(
        &mut self,
        length: usize,
        stack: &Stack,
        cap: usize,
        b: &mut Budget,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<(), Fault> {
        if length == 0 {
            return Ok(());
        }
        let mut words = [0; 256];
        for (word, scope) in words.iter_mut().zip(stack.native.as_slice()) {
            *word = ScopeId::from_scope(*scope)
                .ok_or(Fault::started("vocabulary_mismatch"))?
                .get();
        }
        let id = self.context(&words[..stack.native.len()], b, reserve)?;
        self.span(length, id, cap, b, reserve)
    }
    fn emit_window(
        &mut self,
        window: &Window,
        cap: usize,
        b: &mut Budget,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<(), Fault> {
        b.add(bytes::<u32>(window.paths.len())?, reserve)?;
        let mut ids = Vec::with_capacity(window.paths.len());
        for path in &window.paths {
            ids.push(self.context(path, b, reserve)?);
        }
        for [length, id] in &window.runs {
            self.span(*length as usize, ids[*id as usize - 1], cap, b, reserve)?;
        }
        b.release(ids.capacity() * 4);
        Ok(())
    }
    fn into_window(self, b: &mut Budget) -> Window {
        b.release(
            self.indices.capacity() * 4
                + self.rows.capacity() * size_of::<Vec<u32>>()
                + self.rows.iter().map(|r| r.capacity() * 4).sum::<usize>(),
        );
        self.window
    }
}
struct State {
    parse: ParseState,
    stack: Stack,
    tail: String,
    basis: Window,
    tail_bytes: u32,
    frozen: bool,
    committed: u32,
    total: u32,
    newlines: usize,
    revision: u32,
    born_ms: u64,
    progress_ms: u64,
}
impl State {
    fn expiry(&self, l: &Limits) -> u64 {
        self.born_ms
            .saturating_add(l.age_ms)
            .min(self.progress_ms.saturating_add(l.idle_ms))
    }
    fn known_bytes(&self) -> usize {
        size_of::<Self>()
            + self.stack.dynamic_bytes()
            + self.tail.capacity()
            + self.basis.dynamic_bytes()
    }
}
enum Slot {
    Idle(Box<State>),
    Busy { serial: u64, expiry: u64 },
}
struct Record {
    owner: String,
    key: String,
    lease: Lease,
    slot: Slot,
}
/// Worker-local !Send parser ownership. The service must discard failed/cancelled work.
/// The caller holds the largest accepted reservation until this Work is consumed.
/// ```compile_fail
/// fn require_send<T: Send>() {}
/// require_send::<occipital::semantic_engine::Work>();
/// ```
pub struct Work {
    state: State,
    input: String,
    cursor: usize,
    replace_from: u32,
    output: Emitter,
    counters: Counters,
    key: Option<(String, String)>,
    lease: Option<Lease>,
    serial: u64,
    finalize: bool,
    done: bool,
    started: bool,
    failed: bool,
    budget: Budget,
    parser_scratch_peak: usize,
}
impl Work {
    pub fn started(&self) -> bool {
        self.started
    }
    pub fn lease(&self) -> Option<Lease> {
        self.lease
    }
    /// Maximum controlled live allocation policy requested of the caller so far.
    pub fn required_bytes(&self) -> usize {
        self.budget.peak
    }
    pub fn parser_scratch_peak_bytes(&self) -> usize {
        self.parser_scratch_peak
    }
    pub fn retained_input_bytes(&self) -> usize {
        self.input.len() + self.state.tail.len()
    }
    /// Earlier batch members retain their result policy charge until settlement.
    pub(crate) fn limit_result(&mut self, words: usize, decoded_bytes: usize) {
        self.output.max_words = crate::limits::CONTEXT_WORDS - words;
        self.output.max_decoded_bytes =
            crate::limits::DECODED_BYTES - crate::limits::SOURCE_BODY_UNITS - decoded_bytes;
    }
}
/// Idle state uses the existing separate state-pool guard. A request reservation
/// callback covers owned work/reply growth, not grammar assets or parser scratch.
/// Slot lookup is bounded by the established lease count; no context registry exists.
pub struct Engine {
    pub limits: Limits,
    syntaxes: &'static SyntaxSet,
    // Increasing lease incarnation order, preserved through removal/replacement.
    slots: Vec<Record>,
    next_serial: u64,
    now_ms: u64,
    #[cfg(test)]
    lease_visits: std::cell::Cell<usize>,
}

impl Engine {
    pub fn new(limits: Limits) -> Self {
        static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
        Self {
            limits,
            syntaxes: SYNTAXES.get_or_init(two_face::syntax::extra_newlines),
            slots: Vec::new(),
            next_serial: 0,
            now_ms: 0,
            #[cfg(test)]
            lease_visits: std::cell::Cell::new(0),
        }
    }
    fn syntax(&self, hint: &SyntaxHint) -> Result<&'static SyntaxReference, Fault> {
        if hint.language.as_ref().is_some_and(|name| name.len() > 128)
            || hint
                .path
                .as_ref()
                .is_some_and(|path| path.len() > crate::limits::PATH_HINT_BYTES)
        {
            return Err(Fault::not_started("invalid_hint"));
        }
        if let Some(language) = hint
            .language
            .as_deref()
            .filter(|language| !language.is_empty())
        {
            let alias = [
                ("typescript", "TypeScript"),
                ("ts", "TypeScript"),
                ("javascript", "JavaScript"),
                ("js", "JavaScript"),
                ("bash", "Bourne Again Shell (bash)"),
                ("sh", "Bourne Again Shell (bash)"),
                ("shell", "Bourne Again Shell (bash)"),
                ("awk", "AWK"),
                ("clojure", "Clojure"),
                ("coffeescript", "CoffeeScript"),
                ("elixir", "Elixir"),
                ("erlang", "Erlang"),
                ("groovy", "Groovy"),
                ("haskell", "Haskell"),
                ("java", "Java"),
                ("julia", "Julia"),
                ("kotlin", "Kotlin"),
                ("ocaml", "OCaml"),
                ("perl", "Perl"),
                ("php", "PHP"),
                ("powershell", "PowerShell"),
                ("python", "Python"),
                ("r", "R"),
                ("racket", "Racket"),
                ("ruby", "Ruby"),
                ("rust", "Rust"),
                ("scala", "Scala"),
                ("swift", "Swift"),
                ("tcl", "Tcl"),
                ("makefile", "Makefile"),
                ("make", "Makefile"),
                ("py", "Python"),
                ("rs", "Rust"),
                ("json", "JSON"),
                ("plaintext", "Plain Text"),
                ("text", "Plain Text"),
                ("txt", "Plain Text"),
            ]
            .into_iter()
            .find(|(name, _)| language.eq_ignore_ascii_case(name))
            .map_or(language, |(_, syntax)| syntax);
            return self
                .syntaxes
                .find_syntax_by_name(alias)
                .or_else(|| self.syntaxes.find_syntax_by_extension(language))
                .ok_or(Fault::not_started("unknown_syntax"));
        }
        if let Some(path) = &hint.path {
            let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
            if let Some(syntax) = self.syntaxes.find_syntax_by_extension(name) {
                return Ok(syntax);
            }
            if let Some((_, extension)) = name.rsplit_once('.') {
                if let Some(syntax) = self.syntaxes.find_syntax_by_extension(extension) {
                    return Ok(syntax);
                }
            }
        }
        Err(Fault::not_started("unknown_syntax"))
    }
    fn state(&self, hint: &SyntaxHint) -> Result<State, Fault> {
        Ok(State {
            parse: ParseState::new(self.syntax(hint)?),
            stack: Stack::new(),
            tail: String::new(),
            basis: Window::default(),
            tail_bytes: 0,
            frozen: false,
            committed: 0,
            total: 0,
            newlines: 0,
            revision: 0,
            born_ms: self.now_ms,
            progress_ms: self.now_ms,
        })
    }
    fn validate_source(
        &self,
        source: &str,
        previous: u32,
        newlines: usize,
        tail: bool,
    ) -> Result<(), Fault> {
        if (previous as usize)
            .checked_add(source.len())
            .is_none_or(|n| n > self.limits.source_bytes.min(crate::limits::SOURCE_BYTES))
        {
            return Err(Fault::not_started("source_limit"));
        }
        let lines = newlines
            + if source.is_empty() {
                usize::from(tail)
            } else {
                crate::limits::source_lines(source)
            };
        if lines > crate::limits::SOURCE_LINES {
            return Err(Fault::not_started("source_limit"));
        }
        Ok(())
    }
    fn position(&self, owner: &str, key: &str) -> Option<usize> {
        self.slots.iter().position(|r| {
            #[cfg(test)]
            self.lease_visits.set(self.lease_visits.get() + 1);
            r.owner == owner && r.key == key
        })
    }
    fn serial(&mut self) -> Result<u64, Fault> {
        self.next_serial = self
            .next_serial
            .checked_add(1)
            .ok_or(Fault::not_started("session_limit"))?;
        Ok(self.next_serial)
    }
    fn work(state: State, input: String, finalize: bool, budget: Budget) -> Work {
        let replace_from = state.committed;
        Work {
            state,
            input,
            cursor: 0,
            replace_from,
            output: Emitter::default(),
            counters: Counters::default(),
            key: None,
            lease: None,
            serial: 0,
            finalize,
            done: false,
            started: false,
            failed: false,
            budget,
            parser_scratch_peak: 0,
        }
    }
    pub fn begin_one_shot(
        &mut self,
        source: String,
        hint: &SyntaxHint,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<Work, Fault> {
        self.validate_source(&source, 0, 0, false)?;
        let state = self.state(hint)?;
        let mut budget = Budget::default();
        budget.add(size_of::<Work>() + source.capacity(), reserve)?;
        Ok(Self::work(state, source, true, budget))
    }
    pub fn begin_open(
        &mut self,
        owner: &str,
        key: &str,
        source: String,
        hint: &SyntaxHint,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<Work, Fault> {
        if owner.is_empty() || key.is_empty() || owner.len() > 64 || key.len() > 64 {
            return Err(Fault::not_started("invalid_session"));
        }
        self.validate_source(&source, 0, 0, false)?;
        let state = self.state(hint)?;
        let position = self.position(owner, key);
        if position.is_some_and(|i| matches!(self.slots[i].slot, Slot::Busy { .. })) {
            return Err(Fault::not_started("busy"));
        }
        if position.is_none()
            && (self.slots.len() >= self.limits.leases
                || self.slots.iter().filter(|r| r.owner == owner).count() >= self.limits.per_scope)
        {
            return Err(Fault::not_started("session_limit"));
        }
        let mut budget = Budget::default();
        budget.add(
            size_of::<Work>() + source.capacity() + 2 * (owner.len() + key.len()),
            reserve,
        )?;
        if self
            .retained_state_bytes()
            .checked_add(owner.len() + key.len())
            .is_none_or(|n| n > self.limits.state_pool_bytes)
        {
            return Err(Fault::not_started("state_limit"));
        }
        if position.is_none() && self.slots.len() == self.slots.capacity() {
            let cap = self
                .slots
                .capacity()
                .checked_mul(2)
                .ok_or(Fault::not_started("state_limit"))?
                .max(4);
            let additional = bytes::<Record>(cap)?;
            if self
                .retained_state_bytes()
                .checked_add(additional)
                .and_then(|n| n.checked_add(owner.len()))
                .and_then(|n| n.checked_add(key.len()))
                .is_none_or(|n| n > self.limits.state_pool_bytes)
            {
                return Err(Fault::not_started("state_limit"));
            }
            // The caller funds gross new capacity while old state credit is still
            // live; keep this allowance through Work settlement/state handoff.
            budget.add(additional, reserve)?;
            self.slots
                .try_reserve_exact(cap - self.slots.len())
                .map_err(|_| Fault::not_started("state_limit"))?;
        }
        let serial = self.serial()?;
        let lease = Lease(serial);
        let expiry = state.expiry(&self.limits);
        let record = Record {
            owner: owner.to_owned(),
            key: key.to_owned(),
            lease,
            slot: Slot::Busy { serial, expiry },
        };
        if let Some(i) = position {
            self.slots.remove(i);
        }
        self.slots.push(record);
        let mut work = Self::work(state, source, false, budget);
        work.key = Some((owner.to_owned(), key.to_owned()));
        work.serial = serial;
        work.lease = Some(lease);
        Ok(work)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn begin_append(
        &mut self,
        owner: &str,
        key: &str,
        lease: Lease,
        revision: u32,
        bytes: u32,
        source: String,
        finalize: bool,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<Work, Fault> {
        let index = self
            .position(owner, key)
            .ok_or(Fault::not_started("restart_required"))?;
        let record = &self.slots[index];
        if record.lease != lease {
            return Err(Fault::not_started("restart_required"));
        }
        let state = match &record.slot {
            Slot::Idle(s) => s,
            Slot::Busy { .. } => return Err(Fault::not_started("busy")),
        };
        if state.revision != revision || state.total != bytes || revision == u32::MAX {
            return Err(Fault::not_started("restart_required"));
        }
        self.validate_source(&source, state.total, state.newlines, state.tail_bytes > 0)?;
        let mut budget = Budget::default();
        budget.add(
            size_of::<Work>() + source.capacity() + state.known_bytes() + owner.len() + key.len(),
            reserve,
        )?;
        let expiry = state.expiry(&self.limits);
        let serial = self.serial()?;
        let Slot::Idle(state) =
            std::mem::replace(&mut self.slots[index].slot, Slot::Busy { serial, expiry })
        else {
            unreachable!()
        };
        budget.release(size_of::<State>());
        let mut work = Self::work(*state, source, finalize, budget);
        work.key = Some((owner.to_owned(), key.to_owned()));
        work.lease = Some(lease);
        work.serial = serial;
        Ok(work)
    }
    fn active(&self, work: &Work) -> bool {
        !work.failed
            && work.key.as_ref().is_none_or(|(owner, key)| {
                self.position(owner, key).is_some_and(|i| {
                    self.slots[i].lease == work.lease.unwrap()
                        && matches!(self.slots[i].slot,Slot::Busy{serial,..}if serial==work.serial)
                })
            })
    }
    fn retire(&mut self, work: &Work) {
        if let Some((owner, key)) = &work.key {
            if let Some(i) = self.position(owner, key) {
                if self.slots[i].lease == work.lease.unwrap()
                    && matches!(self.slots[i].slot,Slot::Busy{serial,..}if serial==work.serial)
                {
                    self.remove(i);
                }
            }
        }
    }
    fn remove(&mut self, index: usize) {
        self.slots.remove(index);
        if self.slots.is_empty() {
            self.slots = Vec::new();
        }
    }
    /// The only clock check is the existing cooperative line/byte/time quantum.
    pub fn step(
        &mut self,
        work: &mut Work,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<bool, Fault> {
        if !self.active(work) {
            return Err(Fault {
                code: "scope_gone",
                started: work.started,
            });
        }
        let result = self.step_inner(work, reserve);
        if let Err(mut fault) = result {
            self.retire(work);
            work.failed = true;
            fault.started = work.started;
            return Err(fault);
        }
        result
    }
    fn step_inner(
        &self,
        w: &mut Work,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<bool, Fault> {
        if w.done {
            return Ok(true);
        }
        if w.input.is_empty() {
            w.output
                .emit_window(&w.state.basis, self.limits.runs, &mut w.budget, reserve)?;
            w.output.span(
                (w.state.tail_bytes - w.state.tail.len() as u32) as usize,
                0,
                self.limits.runs,
                &mut w.budget,
                reserve,
            )?;
            w.started = true;
            w.done = true;
            return Ok(true);
        }
        let start = std::time::Instant::now();
        let mut lines = 0;
        let mut processed = 0;
        while w.cursor < w.input.len() {
            let remaining = &w.input[w.cursor..];
            let length = remaining.find('\n').map_or(remaining.len(), |i| i + 1);
            let size = w.state.tail.len() + length;
            if lines > 0
                && (lines >= 64
                    || processed + size > 64 << 10
                    || start.elapsed().as_millis() >= self.limits.quantum_ms as u128)
            {
                return Ok(false);
            }
            let part = &remaining[..length];
            let state = &mut w.state;
            let full = state.tail_bytes + length as u32;
            if part.ends_with('\n') {
                let prefix;
                if state.frozen {
                    prefix = state.tail.len();
                    w.output
                        .emit_window(&state.basis, self.limits.runs, &mut w.budget, reserve)?;
                } else {
                    let text = if state.tail_bytes == 0 {
                        &part[..prefix_len(part, self.limits.line_bytes)]
                    } else {
                        let end = prefix_len(part, self.limits.line_bytes - state.tail.len());
                        append_text(&mut state.tail, &part[..end], &mut w.budget, reserve)?;
                        &state.tail
                    };
                    prefix = text.len();
                    if !text.is_empty() {
                        w.started = true;
                        w.counters.committed_line_calls += 1;
                        w.counters.committed_line_bytes += text.len() as u64;
                        let mut admission = Admission {
                            budget: &mut w.budget,
                            reserve,
                            cap: self.limits.runs,
                            scratch: &mut w.parser_scratch_peak,
                        };
                        parse_line(
                            &mut state.parse,
                            &mut state.stack,
                            text,
                            self.syntaxes,
                            &mut w.output,
                            &mut admission,
                        )?;
                    }
                }
                w.output.span(
                    full as usize - prefix,
                    0,
                    self.limits.runs,
                    &mut w.budget,
                    reserve,
                )?;
                state.committed += full;
                state.newlines += 1;
                w.budget
                    .release(state.tail.capacity() + state.basis.dynamic_bytes());
                state.tail = String::new();
                state.basis = Window::default();
                state.tail_bytes = 0;
                state.frozen = false;
            } else {
                if !state.frozen {
                    let end = prefix_len(part, self.limits.line_bytes - state.tail.len());
                    append_text(&mut state.tail, &part[..end], &mut w.budget, reserve)?;
                    let mut stack = state.stack.preview(&mut w.budget, reserve)?;
                    let mut parse = state.parse.clone();
                    let mut output = Emitter::default();
                    if !state.tail.is_empty() {
                        w.started = true;
                        w.counters.tail_calls += 1;
                        w.counters.tail_bytes += state.tail.len() as u64;
                        let mut admission = Admission {
                            budget: &mut w.budget,
                            reserve,
                            cap: self.limits.runs,
                            scratch: &mut w.parser_scratch_peak,
                        };
                        parse_line(
                            &mut parse,
                            &mut stack,
                            &state.tail,
                            self.syntaxes,
                            &mut output,
                            &mut admission,
                        )?;
                    }
                    w.budget.release(state.basis.dynamic_bytes());
                    state.basis = output.into_window(&mut w.budget);
                    if end < part.len() || state.tail.len() == self.limits.line_bytes {
                        w.budget.release(state.stack.dynamic_bytes());
                        state.stack = stack;
                        state.parse = parse;
                        state.frozen = true;
                    } else {
                        w.budget.release(stack.dynamic_bytes());
                    }
                }
                state.tail_bytes = full;
                w.output
                    .emit_window(&state.basis, self.limits.runs, &mut w.budget, reserve)?;
                w.output.span(
                    full as usize - state.tail.len(),
                    0,
                    self.limits.runs,
                    &mut w.budget,
                    reserve,
                )?;
            }
            w.started = true;
            w.cursor += length;
            lines += 1;
            processed += size;
        }
        w.done = true;
        Ok(true)
    }
    pub fn finish(
        &mut self,
        mut w: Work,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<SourceChunk, Fault> {
        if !w.done || !self.active(&w) {
            let fault = Fault {
                code: "scope_gone",
                started: w.started,
            };
            self.discard(w);
            return Err(fault);
        }
        w.state.total += w.input.len() as u32;
        w.state.revision += 1;
        if !w.input.is_empty() {
            w.state.progress_ms = self.now_ms;
        }
        let chunk = SourceChunk {
            revision: w.state.revision,
            source_bytes: w.state.total,
            committed_bytes: if w.finalize {
                w.state.total
            } else {
                w.state.committed
            },
            replace_from: w.replace_from,
            contexts: std::mem::take(&mut w.output.rows),
            runs: std::mem::take(&mut w.output.window.runs),
            counters: w.counters.clone(),
        };
        if let Some((owner, key)) = &w.key {
            if w.finalize {
                self.retire(&w);
            } else {
                if self
                    .retained_state_bytes()
                    .checked_add(w.state.known_bytes())
                    .is_none_or(|n| n > self.limits.state_pool_bytes)
                {
                    self.retire(&w);
                    return Err(Fault::started("state_limit"));
                }
                if w.budget.add(size_of::<State>(), reserve).is_err() {
                    self.retire(&w);
                    return Err(Fault::started("data_limit"));
                }
                let index = self.position(owner, key).unwrap();
                self.slots[index].slot = Slot::Idle(Box::new(w.state));
            }
        }
        Ok(chunk)
    }
    pub fn discard(&mut self, work: Work) {
        self.retire(&work);
    }
    pub fn close(&mut self, owner: &str, key: &str, lease: Lease) -> bool {
        if let Some(i) = self.position(owner, key) {
            if self.slots[i].lease == lease {
                self.remove(i);
                return true;
            }
        }
        false
    }
    pub fn close_scope(&mut self, owner: &str) {
        self.slots.retain(|r| r.owner != owner);
        if self.slots.is_empty() {
            self.slots = Vec::new();
        }
    }
    pub fn retained_tail_bytes(&self) -> usize {
        self.slots
            .iter()
            .map(|r| match &r.slot {
                Slot::Idle(s) => s.tail.len(),
                _ => 0,
            })
            .sum()
    }
    pub fn retained_state_bytes(&self) -> usize {
        self.slots.capacity() * size_of::<Record>()
            + self
                .slots
                .iter()
                .map(|r| {
                    r.owner.capacity()
                        + r.key.capacity()
                        + match &r.slot {
                            Slot::Idle(s) => s.known_bytes(),
                            _ => 0,
                        }
                })
                .sum::<usize>()
    }
    /// Validate the whole finite batch before constructing any Work.
    pub fn validate_input(&self, source: &str, hint: &SyntaxHint) -> Result<(), Fault> {
        self.validate_source(source, 0, 0, false)?;
        self.syntax(hint).map(|_| ())
    }
    pub(crate) fn ordered_leases(&self) -> impl Iterator<Item = (&str, &str, Lease)> {
        self.slots.iter().map(|r| {
            #[cfg(test)]
            self.lease_visits.set(self.lease_visits.get() + 1);
            (r.owner.as_str(), r.key.as_str(), r.lease)
        })
    }
    #[cfg(test)]
    pub(crate) fn take_lease_visits(&self) -> usize {
        self.lease_visits.replace(0)
    }
    pub fn contains(&self, owner: &str, key: &str, lease: Lease) -> bool {
        self.position(owner, key)
            .is_some_and(|i| self.slots[i].lease == lease)
    }
    /// Persistent slot capacity AND keys remain state-owned while busy. Only the
    /// moved parser State belongs to Work; retained_state_bytes already excludes it.
    pub fn retained_idle_state_bytes(&self) -> usize {
        self.retained_state_bytes()
    }
    pub fn leases(&self) -> usize {
        self.slots.len()
    }
    pub fn next_expiry(&self) -> Option<u64> {
        self.slots
            .iter()
            .map(|r| match &r.slot {
                Slot::Idle(s) => s.expiry(&self.limits),
                Slot::Busy { expiry, .. } => *expiry,
            })
            .min()
    }
    pub fn advance_clock(&mut self, now: u64) {
        self.now_ms = self.now_ms.max(now);
        self.slots.retain(|r| {
            #[cfg(test)]
            self.lease_visits.set(self.lease_visits.get() + 1);
            let expiry = match &r.slot {
                Slot::Idle(s) => s.expiry(&self.limits),
                Slot::Busy { expiry, .. } => *expiry,
            };
            self.now_ms < expiry
        });
        if self.slots.is_empty() {
            self.slots = Vec::new();
        }
    }
}
fn prefix_len(text: &str, limit: usize) -> usize {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}
struct Admission<'a> {
    budget: &'a mut Budget,
    reserve: &'a mut dyn FnMut(usize) -> bool,
    cap: usize,
    scratch: &'a mut usize,
}
fn parse_line(
    parse: &mut ParseState,
    stack: &mut Stack,
    text: &str,
    syntaxes: &SyntaxSet,
    output: &mut Emitter,
    a: &mut Admission<'_>,
) -> Result<(), Fault> {
    let operations = parse
        .parse_line(text, syntaxes)
        .map_err(|_| Fault::started("parser_error"))?;
    *a.scratch = (*a.scratch).max(operations.capacity() * size_of::<(usize, ScopeStackOp)>());
    apply_operations(stack, text, &operations, output, a)
}
fn apply_operations(
    stack: &mut Stack,
    text: &str,
    operations: &[(usize, ScopeStackOp)],
    output: &mut Emitter,
    a: &mut Admission<'_>,
) -> Result<(), Fault> {
    let mut cursor = 0;
    for (end, operation) in operations {
        if *end < cursor || *end > text.len() || !text.is_char_boundary(*end) {
            return Err(Fault::started("parser_error"));
        }
        output.parsed_span(*end - cursor, stack, a.cap, a.budget, a.reserve)?;
        cursor = *end;
        stack.apply(operation, a.budget, a.reserve)?;
    }
    output.parsed_span(text.len() - cursor, stack, a.cap, a.budget, a.reserve)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_work(engine: &mut Engine, mut work: Work) -> SourceChunk {
        while !engine.step(&mut work, &mut |_| true).unwrap() {}
        engine.finish(work, &mut |_| true).unwrap()
    }

    fn context_at(chunk: &SourceChunk, text: &str, marker: &str) -> Vec<u32> {
        let byte = text[..text.find(marker).expect("marker in source")].len() as u32;
        let mut paths: Vec<Vec<u32>> = Vec::with_capacity(chunk.contexts.len());
        for row in &chunk.contexts {
            let prefix = row[0] as usize;
            let mut path = paths
                .last()
                .map_or_else(Vec::new, |previous| previous[..prefix].to_vec());
            path.extend_from_slice(&row[1..]);
            paths.push(path);
        }
        let mut end = chunk.replace_from;
        for [length, context] in &chunk.runs {
            end += *length;
            if byte < end {
                return paths[(*context - 1) as usize].clone();
            }
        }
        panic!(
            "no source run for marker {marker:?} at byte {byte}; replaced from {}",
            chunk.replace_from
        );
    }

    #[test]
    fn explicit_language_precedes_optional_path_and_supports_pathless_text() {
        let engine = Engine::new(Limits::default());
        let python = engine.syntaxes.find_syntax_by_name("Python").unwrap();
        let plain = engine.syntaxes.find_syntax_by_name("Plain Text").unwrap();
        let rust = engine.syntaxes.find_syntax_by_name("Rust").unwrap();
        assert!(std::ptr::eq(
            engine
                .syntax(&SyntaxHint {
                    language: Some("python".into()),
                    path: Some("script.txt".into())
                })
                .unwrap(),
            python
        ));
        assert!(std::ptr::eq(
            engine
                .syntax(&SyntaxHint {
                    language: Some("text".into()),
                    path: Some("script.py".into())
                })
                .unwrap(),
            plain
        ));
        assert!(std::ptr::eq(
            engine
                .syntax(&SyntaxHint {
                    language: None,
                    path: Some("module.rs".into())
                })
                .unwrap(),
            rust
        ));
        assert!(std::ptr::eq(
            engine
                .syntax(&SyntaxHint {
                    language: Some(String::new()),
                    path: Some("script.py".into())
                })
                .unwrap(),
            python
        ));
        assert!(std::ptr::eq(
            engine
                .syntax(&SyntaxHint {
                    language: Some("AWK".into()),
                    path: None
                })
                .unwrap(),
            engine.syntaxes.find_syntax_by_name("AWK").unwrap()
        ));
        assert_eq!(
            engine
                .syntax(&SyntaxHint {
                    language: Some("unmapped".into()),
                    path: Some("script.py".into())
                })
                .unwrap_err(),
            Fault::not_started("unknown_syntax")
        );
        assert_eq!(
            engine
                .syntax(&SyntaxHint {
                    language: None,
                    path: None
                })
                .unwrap_err(),
            Fault::not_started("unknown_syntax")
        );
        assert_eq!(
            engine
                .syntax(&SyntaxHint {
                    language: Some(String::new()),
                    path: None
                })
                .unwrap_err(),
            Fault::not_started("unknown_syntax")
        );
    }

    #[test]
    fn every_curated_interpreter_language_resolves_as_a_regular_selector() {
        let engine = Engine::new(Limits::default());
        for language in [
            "awk",
            "bash",
            "clojure",
            "coffeescript",
            "elixir",
            "erlang",
            "groovy",
            "haskell",
            "java",
            "javascript",
            "julia",
            "kotlin",
            "lua",
            "ocaml",
            "perl",
            "php",
            "powershell",
            "python",
            "r",
            "racket",
            "ruby",
            "rust",
            "scala",
            "swift",
            "tcl",
            "typescript",
        ] {
            assert!(
                engine
                    .syntax(&SyntaxHint {
                        language: Some(language.into()),
                        path: None
                    })
                    .is_ok(),
                "{language}"
            );
        }
    }

    #[test]
    fn explicit_language_parser_state_survives_open_append_and_finalize() {
        let hint = SyntaxHint {
            language: Some("python".into()),
            path: None,
        };
        let initial = "#!/usr/bin/env python3\nvalue = '";
        let first_append = "continued";
        let final_append = "'\nprint(value)\n";
        let complete = format!("{initial}{first_append}{final_append}");
        let mut engine = Engine::new(Limits::default());
        let opened_work = engine
            .begin_open("test", "shebang-stream", initial.into(), &hint, &mut |_| {
                true
            })
            .unwrap();
        let lease = opened_work.lease().unwrap();
        let opened = run_work(&mut engine, opened_work);
        let continued_work = engine
            .begin_append(
                "test",
                "shebang-stream",
                lease,
                opened.revision,
                opened.source_bytes,
                first_append.into(),
                false,
                &mut |_| true,
            )
            .unwrap();
        let continued = run_work(&mut engine, continued_work);
        assert!(engine.contains("test", "shebang-stream", lease));
        let final_work = engine
            .begin_append(
                "test",
                "shebang-stream",
                lease,
                continued.revision,
                continued.source_bytes,
                final_append.into(),
                true,
                &mut |_| true,
            )
            .unwrap();
        let streamed = run_work(&mut engine, final_work);
        assert!(!engine.contains("test", "shebang-stream", lease));

        let mut one_shot_engine = Engine::new(Limits::default());
        let one_shot_work = one_shot_engine
            .begin_one_shot(complete.clone(), &hint, &mut |_| true)
            .unwrap();
        let one_shot = run_work(&mut one_shot_engine, one_shot_work);
        assert_eq!(
            context_at(&streamed, &complete, "print(value)"),
            context_at(&one_shot, &complete, "print(value)"),
            "append reuses the explicitly selected Python parser initialized at stream open",
        );
    }

    #[test]
    fn independent_actor_engines_borrow_the_same_asset_set() {
        let first = Engine::new(Limits::default());
        let second = Engine::new(Limits::default());
        assert!(std::ptr::eq(first.syntaxes, second.syntaxes));
    }
    #[test]
    fn complete_zero_width_clear_restore_and_parsed_empty_are_distinct() {
        let a = ScopeId::from_name("source.rust").unwrap().scope();
        let b = ScopeId::from_name("comment").unwrap().scope();
        let operations = vec![
            (0, ScopeStackOp::Push(a)),
            (0, ScopeStackOp::Push(a)),
            (0, ScopeStackOp::Push(b)),
            (1, ScopeStackOp::Clear(ClearAmount::TopN(1))),
            (2, ScopeStackOp::Clear(ClearAmount::All)),
            (3, ScopeStackOp::Restore),
            (4, ScopeStackOp::Restore),
            (5, ScopeStackOp::Pop(3)),
            (5, ScopeStackOp::Push(a)),
        ];
        let mut stack = Stack::new();
        let mut output = Emitter::default();
        let mut budget = Budget::default();
        let mut scratch = 0;
        let mut reserve = |_| true;
        apply_operations(
            &mut stack,
            "abcde",
            &operations,
            &mut output,
            &mut Admission {
                budget: &mut budget,
                reserve: &mut reserve,
                cap: 100,
                scratch: &mut scratch,
            },
        )
        .unwrap();
        assert_eq!(stack.native.as_slice(), &[a]);
        assert_eq!(stack.count, 0);
        assert_eq!(
            output.window.paths[0],
            vec![
                ScopeId::from_scope(a).unwrap().get(),
                ScopeId::from_scope(a).unwrap().get(),
                ScopeId::from_scope(b).unwrap().get()
            ]
        );
        assert!(output.window.paths.iter().any(Vec::is_empty));
        assert_eq!(
            output.rows,
            vec![
                vec![
                    0,
                    ScopeId::from_scope(a).unwrap().get(),
                    ScopeId::from_scope(a).unwrap().get(),
                    ScopeId::from_scope(b).unwrap().get()
                ],
                vec![2],
                vec![0]
            ]
        );
        assert!(output.window.runs.iter().all(|r| r[1] > 0));
        assert_eq!(output.window.runs.iter().map(|r| r[0]).sum::<u32>(), 5);
        let mut independent = ScopeStack::new();
        for (_, operation) in operations {
            independent.apply(&operation).unwrap();
        }
        assert_eq!(stack.native, independent);
    }
    #[test]
    fn native_depth_clear_and_unknown_scope_guards_have_no_lossy_projection() {
        let scope = ScopeId::from_name("comment").unwrap().scope();
        let mut stack = Stack::new();
        let mut budget = Budget::default();
        let mut reserve = |_| true;
        for _ in 0..256 {
            stack
                .apply(&ScopeStackOp::Push(scope), &mut budget, &mut reserve)
                .unwrap();
        }
        assert_eq!(
            stack
                .apply(&ScopeStackOp::Push(scope), &mut budget, &mut reserve)
                .unwrap_err()
                .code,
            "scope_limit"
        );
        for _ in 0..256 {
            stack
                .apply(
                    &ScopeStackOp::Clear(ClearAmount::All),
                    &mut budget,
                    &mut reserve,
                )
                .unwrap();
        }
        assert_eq!(
            stack
                .apply(
                    &ScopeStackOp::Clear(ClearAmount::All),
                    &mut budget,
                    &mut reserve
                )
                .unwrap_err()
                .code,
            "scope_limit"
        );
        let clone = stack.preview(&mut budget, &mut reserve).unwrap();
        budget.release(clone.dynamic_bytes());
        drop(clone);
        for _ in 0..256 {
            stack
                .apply(&ScopeStackOp::Restore, &mut budget, &mut reserve)
                .unwrap();
        }
        assert_eq!(stack.native.len(), 256);
        assert_eq!(budget.held, stack.dynamic_bytes());
        let unknown = Scope::new("semantic-engine-not-in-assets").unwrap();
        let mut empty = Stack::new();
        assert_eq!(
            empty
                .apply(&ScopeStackOp::Push(unknown), &mut budget, &mut reserve)
                .unwrap_err()
                .code,
            "vocabulary_mismatch"
        );
        assert!(empty.native.is_empty());
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn denied_tail_checkpoint_clone_does_not_claim_parser_start() {
        let mut engine = Engine::new(Limits::default());
        let mut work = engine
            .begin_one_shot(
                "x".into(),
                &SyntaxHint {
                    language: Some("text".into()),
                    path: None,
                },
                &mut |_| true,
            )
            .unwrap();
        // A retained native-depth checkpoint can need more controlled clone space
        // than the work header. Deny that growth, before parse_line is invoked.
        let scope = ScopeId::from_name("comment").unwrap().scope();
        for _ in 0..256 {
            work.state
                .stack
                .apply(&ScopeStackOp::Push(scope), &mut work.budget, &mut |_| true)
                .unwrap();
        }
        assert_eq!(
            engine.step(&mut work, &mut |_| false).unwrap_err(),
            Fault::not_started("data_limit")
        );
        assert_eq!(work.counters, Counters::default());
        assert_eq!(work.parser_scratch_peak_bytes(), 0);
        engine.discard(work);
    }
}

#[cfg(test)]
mod service_slot_admission_tests {
    use super::*;
    #[test]
    fn open_slot_capacity_requires_gross_growth_grant_before_allocation() {
        let mut engine = Engine::new(Limits::default());
        let hint = SyntaxHint {
            language: Some("text".into()),
            path: None,
        };
        let base = size_of::<Work>() + 4; // r/k are duplicated into Work and Record.
        let mut requests = Vec::new();
        let result = engine.begin_open("r", "k", String::new(), &hint, &mut |required| {
            requests.push(required);
            required <= base
        });
        assert_eq!(
            result.err(),
            Some(Fault::not_started("data_limit")),
            "slot expansion cannot silently use only the Work header allowance"
        );
        assert_eq!(engine.leases(), 0);
        assert_eq!(engine.retained_state_bytes(), 0);
        assert_eq!(requests, vec![base, base + 4 * size_of::<Record>()]);
        let exact = base + 4 * size_of::<Record>();
        let work = engine
            .begin_open("r", "k", String::new(), &hint, &mut |n| n <= exact)
            .unwrap();
        assert_eq!(work.required_bytes(), exact);
        assert_eq!(engine.slots.capacity(), 4);
        engine.discard(work);
        assert_eq!(engine.retained_state_bytes(), 0);
    }
    #[test]
    fn replacing_slot_capacity_funds_old_new_overlap_and_denial_keeps_old_leases() {
        let mut engine = Engine::new(Limits::default());
        let hint = SyntaxHint {
            language: Some("text".into()),
            path: None,
        };
        let mut work = Vec::new();
        for n in 0..4 {
            work.push(
                engine
                    .begin_open("r", &format!("k{n}"), String::new(), &hint, &mut |_| true)
                    .unwrap(),
            );
        }
        let retained = engine.retained_state_bytes();
        let expected = size_of::<Work>() + 6 + 8 * size_of::<Record>();
        assert_eq!(
            engine
                .begin_open("r", "k4", String::new(), &hint, &mut |n| n < expected)
                .err(),
            Some(Fault::not_started("data_limit"))
        );
        assert_eq!(engine.retained_state_bytes(), retained);
        assert_eq!(engine.slots.capacity(), 4);
        assert_eq!(engine.leases(), 4);
        let fifth = engine
            .begin_open("r", "k4", String::new(), &hint, &mut |n| n <= expected)
            .unwrap();
        assert_eq!(fifth.required_bytes(), expected);
        assert_eq!(engine.slots.capacity(), 8);
        for (n, pending) in work.into_iter().enumerate() {
            assert!(engine.contains("r", &format!("k{n}"), pending.lease().unwrap()));
            engine.discard(pending);
        }
        engine.discard(fifth);
        assert_eq!(engine.retained_state_bytes(), 0);
    }
}

#[cfg(test)]
mod volume_tests {
    use super::*;

    #[test]
    fn producer_rejects_expanded_words_before_path_copy_or_reservation() {
        let mut output = Emitter::default();
        let mut budget = Budget::default();
        for id in 1..=256 {
            let path = vec![id; 256];
            output.context(&path, &mut budget, &mut |_| true).unwrap();
        }
        assert_eq!(output.words, crate::limits::CONTEXT_WORDS);
        let before = (budget.peak, output.rows.len(), output.window.paths.len());
        assert_eq!(
            output
                .context(&[1], &mut budget, &mut |_| panic!(
                    "over-policy path must not allocate"
                ))
                .unwrap_err(),
            Fault::started("context_limit")
        );
        assert_eq!(
            (budget.peak, output.rows.len(), output.window.paths.len()),
            before
        );
        assert_eq!(
            output
                .context(&[1; 256], &mut budget, &mut |_| panic!(
                    "existing paths need no allocation"
                ))
                .unwrap(),
            1
        );
    }

    #[test]
    fn producer_counts_empty_contexts_and_run_pairs_before_decoded_growth() {
        let mut output = Emitter::default();
        let mut budget = Budget::default();
        let mut accepted = 0;
        loop {
            let path = [accepted / 256 + 1, accepted % 256 + 1];
            match output.context(&path, &mut budget, &mut |_| true) {
                Ok(_) => accepted += 1,
                Err(fault) => {
                    assert_eq!(fault, Fault::started("result_limit"));
                    break;
                }
            }
        }
        assert!(output.words < crate::limits::CONTEXT_WORDS);
        assert!(
            output.decoded_bytes <= crate::limits::DECODED_BYTES - crate::limits::SOURCE_BODY_UNITS
        );
        assert_eq!(output.rows.len(), accepted as usize);
        let mut empty = Emitter {
            max_decoded_bytes: crate::limits::SOURCE_UNITS + crate::limits::CONTEXT_ROW_UNITS + 8,
            ..Emitter::default()
        };
        let id = empty.context(&[], &mut budget, &mut |_| true).unwrap();
        empty
            .span(1, id, usize::MAX, &mut budget, &mut |_| true)
            .unwrap();
        empty
            .span(1, id, usize::MAX, &mut budget, &mut |_| {
                panic!("coalesced run")
            })
            .unwrap();
        assert_eq!(
            empty
                .span(1, 0, usize::MAX, &mut budget, &mut |_| panic!(
                    "decoded run cap"
                ))
                .unwrap_err(),
            Fault::started("result_limit")
        );
        assert_eq!(empty.window.runs, vec![[2, id]]);
    }
}
