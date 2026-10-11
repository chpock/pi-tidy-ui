//! Worker-local jobs. Completed source/ranges belong to the client, never to an idle lease.
use crate::{
    profile::{category, default_style, native_style, pi_styles, Profile},
    protocol::{Chunk, Counters, Fault, Role, Run, SyntaxHint, WireStyle},
};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};
use syntect::{
    highlighting::{HighlightState, Highlighter, RangedHighlightIterator},
    parsing::{ParseState, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet},
};

#[derive(Clone, Debug)]
pub struct Limits {
    pub source_bytes: usize,
    /// Classified UTF-8 prefix per line, not an input admission ceiling.
    pub line_bytes: usize,
    pub leases: usize,
    pub per_scope: usize,
    pub state_pool_bytes: usize,
    pub runs: usize,
    pub styles: usize,
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
            styles: crate::limits::STYLES,
            quantum_ms: 2,
            idle_ms: crate::limits::IDLE_MS,
            age_ms: crate::limits::AGE_MS,
        }
    }
}

#[derive(Clone)]
enum PaintState {
    Pi(ScopeStack),
    Native(HighlightState),
}
impl PaintState {
    fn stack(&self) -> &ScopeStack {
        match self {
            Self::Pi(stack) => stack,
            Self::Native(state) => &state.path,
        }
    }
}
struct StyleTable {
    values: Vec<WireStyle>,
    indices: HashMap<WireStyle, u32>,
    cap: usize,
}
impl StyleTable {
    fn new(profile: &Profile, cap: usize) -> Result<Self, Fault> {
        let values = if profile.theme.is_none() {
            pi_styles()
        } else {
            vec![default_style(profile)]
        };
        if values.len() > cap {
            return Err(Fault::not_started("style_limit"));
        }
        let indices = values
            .iter()
            .enumerate()
            .map(|(index, style)| (style.clone(), index as u32))
            .collect();
        Ok(Self {
            values,
            indices,
            cap,
        })
    }
    fn id(&mut self, style: WireStyle) -> Result<u32, Fault> {
        if let Some(index) = self.indices.get(&style) {
            return Ok(*index);
        }
        if self.values.len() >= self.cap {
            return Err(Fault::started("style_limit"));
        }
        let index = self.values.len() as u32;
        self.values.push(style.clone());
        self.indices.insert(style, index);
        Ok(index)
    }
}
struct State {
    parse: ParseState,
    paint: PaintState,
    profile: Arc<Profile>,
    table: StyleTable,
    tail: String,
    tail_runs: Vec<Run>,
    tail_bytes: u32,
    // Once frozen, parse/paint already contain the prefix's continuation. There
    // is no reason to retain a second parser checkpoint for ignored tail text.
    tail_frozen: bool,
    committed: u32,
    total: u32,
    revision: u32,
    clears: usize,
    born_ms: u64,
    progress_ms: u64,
}
impl State {
    fn expiry(&self, limits: &Limits) -> u64 {
        self.born_ms
            .saturating_add(limits.age_ms)
            .min(self.progress_ms.saturating_add(limits.idle_ms))
    }
    /// Known owned containers; Syntect's private parser/highlight heaps are separately
    /// constrained by source/depth/lease bounds and whole-process stress measurement.
    fn known_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.tail.capacity()
            + self.tail_runs.capacity() * std::mem::size_of::<Run>()
            + self.table.values.capacity() * std::mem::size_of::<WireStyle>()
            + self.table.indices.capacity() * (std::mem::size_of::<WireStyle>() + 20)
            + self.paint.stack().scopes.capacity() * std::mem::size_of::<syntect::parsing::Scope>()
    }
    fn emit_tail(&mut self, runs: &mut Vec<Run>, cap: usize) -> Result<(), Fault> {
        for run in &self.tail_runs {
            push(runs, *run, cap)?;
        }
        push_plain(
            &mut self.table,
            self.committed + self.tail.len() as u32,
            self.tail_bytes - self.tail.len() as u32,
            runs,
            cap,
        )
    }
}
enum Slot {
    Idle(Box<State>),
    Busy(u64, u64),
}

/// !Send parser state stays in this job on its owning worker. Only final wire data leaves it.
/// Parser state is confined to its creating actor thread, including while a job yields.
/// ```compile_fail
/// fn require_send<T: Send>() {}
/// require_send::<occipital::engine::Work>();
/// ```
pub struct Work {
    state: State,
    input: String,
    cursor: usize,
    replace_from: u32,
    runs: Vec<Run>,
    counters: Counters,
    key: Option<(String, String)>,
    token: u64,
    finish: bool,
    done: bool,
}
impl Work {
    pub fn started(&self) -> bool {
        self.cursor > 0
            || self.done
            || self.counters.committed_line_calls + self.counters.tail_calls > 0
    }
    pub fn retained_input_bytes(&self) -> usize {
        self.input.len() + self.state.tail.len()
    }
}

pub struct Engine {
    pub limits: Limits,
    syntaxes: &'static SyntaxSet,
    slots: HashMap<(String, String), Slot>,
    next_token: u64,
    now_ms: u64,
    profiles: HashMap<String, Arc<Profile>>,
}
impl Engine {
    pub fn new(limits: Limits) -> Self {
        static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
        Self {
            limits,
            syntaxes: SYNTAXES.get_or_init(two_face::syntax::extra_newlines),
            slots: HashMap::new(),
            next_token: 0,
            now_ms: 0,
            profiles: HashMap::new(),
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
        if let Some(language) = &hint.language {
            let alias = match language.to_ascii_lowercase().as_str() {
                "typescript" | "ts" => "TypeScript",
                "javascript" | "js" => "JavaScript",
                "bash" | "sh" | "shell" => "Bourne Again Shell (bash)",
                "makefile" | "make" => "Makefile",
                "python" | "py" => "Python",
                "rust" | "rs" => "Rust",
                "json" => "JSON",
                "plaintext" | "text" | "txt" => "Plain Text",
                _ => language,
            };
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
                if let Some(syntax) = self
                    .syntaxes
                    .find_syntax_by_extension(&extension.to_ascii_lowercase())
                {
                    return Ok(syntax);
                }
            }
        }
        Err(Fault::not_started("unknown_syntax"))
    }
    fn validate_source(&self, source: &str, previous_total: usize) -> Result<(), Fault> {
        if previous_total
            .checked_add(source.len())
            .is_none_or(|total| total > self.limits.source_bytes || total > u32::MAX as usize)
        {
            return Err(Fault::not_started("source_limit"));
        }
        Ok(())
    }
    fn new_state(&self, hint: &SyntaxHint, profile: Arc<Profile>) -> Result<State, Fault> {
        let syntax = self.syntax(hint)?;
        let paint = if let Some(theme) = &profile.theme {
            PaintState::Native(HighlightState::new(
                &Highlighter::new(theme),
                ScopeStack::new(),
            ))
        } else {
            PaintState::Pi(ScopeStack::new())
        };
        Ok(State {
            parse: ParseState::new(syntax),
            paint,
            table: StyleTable::new(&profile, self.limits.styles)?,
            profile,
            tail: String::new(),
            tail_runs: Vec::new(),
            tail_bytes: 0,
            tail_frozen: false,
            committed: 0,
            total: 0,
            revision: 0,
            clears: 0,
            born_ms: self.now_ms,
            progress_ms: self.now_ms,
        })
    }
    pub(crate) fn profile(&self, name: &str) -> Result<Arc<Profile>, Fault> {
        self.profiles
            .get(name)
            .cloned()
            .map_or_else(|| Profile::resolve(name), Ok)
    }
    pub fn replace_profiles(&mut self, profiles: Vec<Arc<Profile>>) -> Result<(), Fault> {
        if profiles.len() > 16 {
            return Err(Fault::not_started("theme_limit"));
        }
        let mut candidate = HashMap::with_capacity(profiles.len());
        for profile in profiles {
            if let Some(theme) = &profile.theme {
                crate::profile::validate_theme(theme)?;
            }
            if candidate.insert(profile.name.clone(), profile).is_some() {
                return Err(Fault::not_started("theme_limit"));
            }
        }
        self.profiles = candidate;
        Ok(())
    }
    pub fn install_profile(&mut self, profile: Arc<Profile>) -> Result<(), Fault> {
        if let Some(theme) = &profile.theme {
            crate::profile::validate_theme(theme)?;
        }
        if self.profiles.len() >= 16 && !self.profiles.contains_key(&profile.name) {
            return Err(Fault::not_started("theme_limit"));
        }
        self.profiles.insert(profile.name.clone(), profile);
        Ok(())
    }
    pub fn begin_one_shot(
        &mut self,
        source: String,
        hint: &SyntaxHint,
        profile: &str,
    ) -> Result<Work, Fault> {
        self.validate_source(&source, 0)?;
        let state = self.new_state(hint, self.profile(profile)?)?;
        Ok(Work {
            state,
            input: source,
            cursor: 0,
            replace_from: 0,
            runs: Vec::new(),
            counters: Counters::default(),
            key: None,
            token: 0,
            finish: true,
            done: false,
        })
    }
    pub fn begin_open(
        &mut self,
        scope: &str,
        key: &str,
        source: String,
        hint: &SyntaxHint,
        profile: &str,
    ) -> Result<Work, Fault> {
        if scope.len() > 64 || key.len() > 64 || scope.is_empty() || key.is_empty() {
            return Err(Fault::not_started("invalid_session"));
        }
        self.validate_source(&source, 0)?;
        let state = self.new_state(hint, self.profile(profile)?)?;
        let id = (scope.to_owned(), key.to_owned());
        if matches!(self.slots.get(&id), Some(Slot::Busy(_, _))) {
            return Err(Fault::not_started("busy"));
        }
        if !self.slots.contains_key(&id)
            && (self.slots.len() >= self.limits.leases
                || self
                    .slots
                    .keys()
                    .filter(|(owner, _)| owner == scope)
                    .count()
                    >= self.limits.per_scope)
        {
            return Err(Fault::not_started("session_limit"));
        }
        self.next_token = self
            .next_token
            .checked_add(1)
            .ok_or(Fault::not_started("session_limit"))?;
        self.slots.insert(
            id.clone(),
            Slot::Busy(self.next_token, state.expiry(&self.limits)),
        );
        Ok(Work {
            state,
            input: source,
            cursor: 0,
            replace_from: 0,
            runs: Vec::new(),
            counters: Counters::default(),
            key: Some(id),
            token: self.next_token,
            finish: false,
            done: false,
        })
    }
    pub fn begin_append(
        &mut self,
        scope: &str,
        key: &str,
        revision: u32,
        bytes: u32,
        source: String,
        finish: bool,
    ) -> Result<Work, Fault> {
        let id = (scope.to_owned(), key.to_owned());
        let state = match self.slots.get(&id) {
            Some(Slot::Idle(state)) => state,
            Some(Slot::Busy(_, _)) => return Err(Fault::not_started("busy")),
            None => return Err(Fault::not_started("restart_required")),
        };
        if state.revision != revision || state.total != bytes || revision == u32::MAX {
            return Err(Fault::not_started("restart_required"));
        }
        if self.profile(&state.profile.name)?.fingerprint != state.profile.fingerprint {
            return Err(Fault::not_started("restart_required"));
        }
        self.validate_source(&source, state.total as usize)?;
        let expiry = state.expiry(&self.limits);
        self.next_token = self
            .next_token
            .checked_add(1)
            .ok_or(Fault::not_started("session_limit"))?;
        let Some(Slot::Idle(state)) = self
            .slots
            .insert(id.clone(), Slot::Busy(self.next_token, expiry))
        else {
            unreachable!("validated idle state")
        };
        let replace_from = state.committed;
        Ok(Work {
            state: *state,
            input: source,
            cursor: 0,
            replace_from,
            runs: Vec::new(),
            counters: Counters::default(),
            key: Some(id),
            token: self.next_token,
            finish,
            done: false,
        })
    }
    fn active(&self, work: &Work) -> bool {
        work.key.as_ref().is_none_or(
            |key| matches!(self.slots.get(key),Some(Slot::Busy(token, _))if *token==work.token),
        )
    }
    /// A line/byte quantum. The time target is checked between calls; it cannot
    /// interrupt an individual synchronous parse of the admitted prefix.
    pub fn step(&mut self, work: &mut Work) -> Result<bool, Fault> {
        if !self.active(work) {
            return Err(Fault {
                code: "scope_gone",
                started: work.started(),
            });
        }
        if work.done {
            return Ok(true);
        }
        if work.input.is_empty() {
            work.state.emit_tail(&mut work.runs, self.limits.runs)?;
            work.done = true;
            return Ok(true);
        }
        let profile = work.state.profile.clone();
        let quantum_start = std::time::Instant::now();
        let highlighter = profile.theme.as_ref().map(|theme| Highlighter::new(theme));
        let mut lines = 0;
        let mut processed = 0;
        while work.cursor < work.input.len() {
            let remaining = &work.input[work.cursor..];
            let length = remaining
                .find('\n')
                .map_or(remaining.len(), |index| index + 1);
            let size = work.state.tail.len() + length;
            if lines > 0
                && (lines >= 64
                    || processed + size > 64 << 10
                    || quantum_start.elapsed().as_millis() >= self.limits.quantum_ms as u128)
            {
                return Ok(false);
            }
            let part = &remaining[..length];
            let state = &mut work.state;
            let full_bytes = state.tail_bytes + length as u32;
            if part.ends_with('\n') {
                let prefix_bytes;
                if state.tail_frozen {
                    // The prefix is unchanged, including its parser/paint context.
                    // The real newline belongs to the ignored suffix, not to parsing.
                    prefix_bytes = state.tail.len();
                    for run in &state.tail_runs {
                        push(&mut work.runs, *run, self.limits.runs)?;
                    }
                } else {
                    // Preserve zero-copy parsing of ordinary complete lines.
                    let text = if state.tail_bytes == 0 {
                        &part[..prefix_len(part, self.limits.line_bytes)]
                    } else {
                        let end = prefix_len(part, self.limits.line_bytes - state.tail.len());
                        state.tail.push_str(&part[..end]);
                        &state.tail
                    };
                    prefix_bytes = text.len();
                    if !text.is_empty() {
                        work.counters.committed_line_calls += 1;
                        work.counters.committed_line_bytes += text.len() as u64;
                        parse_line(
                            &mut state.parse,
                            &mut state.paint,
                            &mut state.clears,
                            &mut state.table,
                            highlighter.as_ref(),
                            self.syntaxes,
                            text,
                            state.committed,
                            &mut work.runs,
                            self.limits.runs,
                        )?;
                    }
                }
                push_plain(
                    &mut state.table,
                    state.committed + prefix_bytes as u32,
                    full_bytes - prefix_bytes as u32,
                    &mut work.runs,
                    self.limits.runs,
                )?;
                state.committed += full_bytes;
                state.tail = String::new();
                state.tail_runs = Vec::new();
                state.tail_bytes = 0;
                state.tail_frozen = false;
            } else {
                if !state.tail_frozen {
                    let end = prefix_len(part, self.limits.line_bytes - state.tail.len());
                    state.tail.push_str(&part[..end]);
                    let mut preview = state.parse.clone();
                    let mut paint = state.paint.clone();
                    let mut clears = state.clears;
                    let mut runs = Vec::new();
                    if !state.tail.is_empty() {
                        work.counters.tail_calls += 1;
                        work.counters.tail_bytes += state.tail.len() as u64;
                        parse_line(
                            &mut preview,
                            &mut paint,
                            &mut clears,
                            &mut state.table,
                            highlighter.as_ref(),
                            self.syntaxes,
                            &state.tail,
                            state.committed,
                            &mut runs,
                            self.limits.runs,
                        )?;
                    }
                    state.tail_runs = runs;
                    // A multibyte character can overflow the window before every
                    // byte is filled. That cut is frozen too; never fill the gap
                    // with later suffix characters.
                    if end < part.len() || state.tail.len() == self.limits.line_bytes {
                        state.parse = preview;
                        state.paint = paint;
                        state.clears = clears;
                        state.tail_frozen = true;
                    }
                }
                state.tail_bytes = full_bytes;
                state.emit_tail(&mut work.runs, self.limits.runs)?;
            }
            work.cursor += length;
            lines += 1;
            processed += size;
        }
        work.done = true;
        Ok(true)
    }
    pub fn finish(&mut self, mut work: Work) -> Result<Chunk, Fault> {
        if !work.done || !self.active(&work) {
            self.discard(work);
            return Err(Fault::started("scope_gone"));
        }
        work.state.total += work.input.len() as u32;
        if !work.input.is_empty() {
            work.state.progress_ms = self.now_ms;
        }
        work.state.revision += 1;
        let committed = if work.finish {
            work.state.total
        } else {
            work.state.committed
        };
        let result = Chunk {
            revision: work.state.revision,
            source_bytes: work.state.total,
            committed_bytes: committed,
            replace_from: work.replace_from,
            profile: work.state.profile.name.clone(),
            fingerprint: work.state.profile.fingerprint.clone(),
            styles: work.state.table.values.clone(),
            runs: std::mem::take(&mut work.runs),
            counters: work.counters.clone(),
        };
        if let Some(key) = work.key {
            if work.finish {
                self.slots.remove(&key);
            } else {
                if self.retained_state_bytes() + work.state.known_bytes()
                    > self.limits.state_pool_bytes
                {
                    self.slots.remove(&key);
                    return Err(Fault::started("state_limit"));
                }
                self.slots.insert(key, Slot::Idle(Box::new(work.state)));
            }
        }
        Ok(result)
    }
    pub fn discard(&mut self, work: Work) {
        if let Some(key) = work.key {
            if matches!(self.slots.get(&key),Some(Slot::Busy(token, _))if *token==work.token) {
                self.slots.remove(&key);
            }
        }
    }
    fn execute(&mut self, mut work: Work) -> Result<Chunk, Fault> {
        loop {
            match self.step(&mut work) {
                Ok(true) => return self.finish(work),
                Ok(false) => {}
                Err(error) => {
                    self.discard(work);
                    return Err(error);
                }
            }
        }
    }
    pub fn one_shot(
        &mut self,
        source: &str,
        hint: &SyntaxHint,
        profile: &str,
    ) -> Result<Chunk, Fault> {
        let work = self.begin_one_shot(source.into(), hint, profile)?;
        self.execute(work)
    }
    pub fn open(
        &mut self,
        scope: &str,
        key: &str,
        source: &str,
        hint: &SyntaxHint,
        profile: &str,
    ) -> Result<Chunk, Fault> {
        let work = self.begin_open(scope, key, source.into(), hint, profile)?;
        self.execute(work)
    }
    pub fn append(
        &mut self,
        scope: &str,
        key: &str,
        revision: u32,
        bytes: u32,
        delta: &str,
        finish: bool,
    ) -> Result<Chunk, Fault> {
        let work = self.begin_append(scope, key, revision, bytes, delta.into(), finish)?;
        self.execute(work)
    }
    pub fn contains(&self, scope: &str, key: &str) -> bool {
        self.slots.contains_key(&(scope.into(), key.into()))
    }
    pub fn close_scope(&mut self, scope: &str) {
        self.slots.retain(|(owner, _), _| owner != scope);
    }
    pub fn close(&mut self, scope: &str, key: &str) {
        self.slots.remove(&(scope.into(), key.into()));
    }
    pub fn retained_tail_bytes(&self) -> usize {
        self.slots
            .values()
            .map(|slot| match slot {
                Slot::Idle(state) => state.tail.len(),
                Slot::Busy(_, _) => 0,
            })
            .sum()
    }
    pub(crate) fn is_idle(&self, scope: &str, key: &str) -> bool {
        matches!(
            self.slots.get(&(scope.into(), key.into())),
            Some(Slot::Idle(_))
        )
    }
    pub(crate) fn retained_idle_state_bytes(&self) -> usize {
        self.slots
            .iter()
            .filter_map(|((scope, key), slot)| match slot {
                Slot::Idle(state) => Some(scope.capacity() + key.capacity() + state.known_bytes()),
                Slot::Busy(_, _) => None,
            })
            .sum()
    }
    pub fn retained_state_bytes(&self) -> usize {
        self.slots
            .iter()
            .map(|((scope, key), slot)| {
                scope.capacity()
                    + key.capacity()
                    + match slot {
                        Slot::Idle(state) => state.known_bytes(),
                        Slot::Busy(_, _) => std::mem::size_of::<Slot>(),
                    }
            })
            .sum()
    }
    /// The actor calls this with monotonic elapsed milliseconds before dispatch and
    /// from its nearest-expiry receive timeout. No-op requests do not refresh idle age.
    pub fn advance_clock(&mut self, now_ms: u64) {
        self.now_ms = self.now_ms.max(now_ms);
        let now = self.now_ms;
        self.slots.retain(|_, slot| match slot {
            Slot::Idle(state) => now < state.expiry(&self.limits),
            Slot::Busy(_, expiry) => now < *expiry,
        });
    }
    pub fn next_expiry(&self) -> Option<u64> {
        self.slots
            .values()
            .map(|slot| match slot {
                Slot::Idle(state) => state.expiry(&self.limits),
                Slot::Busy(_, expiry) => *expiry,
            })
            .min()
    }
    pub fn syntax_names(&self) -> Vec<String> {
        self.syntaxes
            .syntaxes()
            .iter()
            .map(|syntax| syntax.name.clone())
            .collect()
    }
    pub fn leases(&self) -> usize {
        self.slots.len()
    }
}

fn prefix_len(text: &str, limit: usize) -> usize {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}
fn push_plain(
    table: &mut StyleTable,
    offset: u32,
    length: u32,
    runs: &mut Vec<Run>,
    cap: usize,
) -> Result<(), Fault> {
    if length == 0 {
        return Ok(());
    }
    let style = table.id(WireStyle::Pi { role: Role::Plain })?;
    push(runs, [offset, length, style], cap)
}
fn push(runs: &mut Vec<Run>, run: Run, cap: usize) -> Result<(), Fault> {
    if run[1] == 0 {
        return Ok(());
    }
    if let Some(last) = runs.last_mut() {
        if last[0] + last[1] == run[0] && last[2] == run[2] {
            last[1] += run[1];
            return Ok(());
        }
    }
    if runs.len() >= cap {
        return Err(Fault::started("result_limit"));
    }
    runs.push(run);
    Ok(())
}
fn apply_depth(stack: &mut ScopeStack, clears: &mut usize, op: &ScopeStackOp) -> Result<(), Fault> {
    match op {
        ScopeStackOp::Clear(_) => *clears += 1,
        ScopeStackOp::Restore => *clears = clears.saturating_sub(1),
        _ => {}
    }
    stack
        .apply(op)
        .map_err(|_| Fault::started("parser_error"))?;
    if stack.len() > 256 || *clears > 256 {
        return Err(Fault::started("scope_limit"));
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn parse_line(
    parse: &mut ParseState,
    paint: &mut PaintState,
    clears: &mut usize,
    table: &mut StyleTable,
    highlighter: Option<&Highlighter<'_>>,
    syntaxes: &SyntaxSet,
    text: &str,
    offset: u32,
    runs: &mut Vec<Run>,
    cap: usize,
) -> Result<(), Fault> {
    let operations = parse
        .parse_line(text, syntaxes)
        .map_err(|_| Fault::started("parser_error"))?;
    // Check depth before native HighlightState allocates its corresponding style stack.
    if matches!(paint, PaintState::Native(_)) {
        let mut check = paint.stack().clone();
        for (_, operation) in &operations {
            apply_depth(&mut check, clears, operation)?;
        }
    }
    match paint {
        PaintState::Pi(stack) => {
            let mut cursor = 0;
            for (end, operation) in &operations {
                if *end < cursor || *end > text.len() || !text.is_char_boundary(*end) {
                    return Err(Fault::started("parser_error"));
                }
                if *end > cursor {
                    let style = table.id(WireStyle::Pi {
                        role: category(stack),
                    })?;
                    push(
                        runs,
                        [offset + cursor as u32, (*end - cursor) as u32, style],
                        cap,
                    )?;
                }
                cursor = *end;
                apply_depth(stack, clears, operation)?;
            }
            if cursor < text.len() {
                let style = table.id(WireStyle::Pi {
                    role: category(stack),
                })?;
                push(
                    runs,
                    [offset + cursor as u32, (text.len() - cursor) as u32, style],
                    cap,
                )?;
            }
        }
        PaintState::Native(state) => {
            let highlighter = highlighter.ok_or(Fault::started("profile_unavailable"))?;
            for (style, _, range) in
                RangedHighlightIterator::new(state, &operations, text, highlighter)
            {
                if !text.is_char_boundary(range.start) || !text.is_char_boundary(range.end) {
                    return Err(Fault::started("parser_error"));
                }
                let style = table.id(native_style(style)?)?;
                push(
                    runs,
                    [
                        offset + range.start as u32,
                        (range.end - range.start) as u32,
                        style,
                    ],
                    cap,
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod shared_assets_tests {
    use super::*;
    #[test]
    fn independent_actor_engines_borrow_the_same_asset_set() {
        let first = Engine::new(Limits::default());
        let second = Engine::new(Limits::default());
        assert!(std::ptr::eq(first.syntaxes, second.syntaxes));
    }
    #[test]
    fn scope_and_cleared_stack_limits_accept_256_and_reject_257() {
        // Normal JSON/TS nesting hits Syntect's own 100-context guard first;
        // directly exercise our scope-operation boundary instead of guessing
        // that grammar context depth equals highlighted scope depth.
        let scope = syntect::parsing::Scope::new("source.test").unwrap();
        let mut stack = ScopeStack::new();
        let mut clears = 0;
        for _ in 0..256 {
            apply_depth(&mut stack, &mut clears, &ScopeStackOp::Push(scope)).unwrap();
        }
        assert_eq!(
            apply_depth(&mut stack, &mut clears, &ScopeStackOp::Push(scope))
                .unwrap_err()
                .code,
            "scope_limit"
        );
        let mut stack = ScopeStack::new();
        let mut clears = 0;
        for _ in 0..256 {
            apply_depth(
                &mut stack,
                &mut clears,
                &ScopeStackOp::Clear(syntect::parsing::ClearAmount::All),
            )
            .unwrap();
        }
        assert_eq!(
            apply_depth(
                &mut stack,
                &mut clears,
                &ScopeStackOp::Clear(syntect::parsing::ClearAmount::All)
            )
            .unwrap_err()
            .code,
            "scope_limit"
        );
    }
}
