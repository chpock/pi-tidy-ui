//! Actual executable, framed pipes and native Syntect state.
mod support;

use occipital::{frame, profile::Profile, reply::REPLY_BYTES, request::REQUEST_BYTES};
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Child, ChildStdin, Stdio},
    sync::mpsc::{self, Receiver},
    thread::JoinHandle,
    time::Duration,
};
struct Helper {
    child: Child,
    input: Option<ChildStdin>,
    replies: Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    _root: support::CaseDir,
}
impl Helper {
    fn new() -> Self {
        let root = support::CaseDir::new("stdio");
        let mut child = root
            .command(env!("CARGO_BIN_EXE_occipital"))
            .args(["--stdio", "--config"])
            .arg(root.join("missing/config.json"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let mut output = child.stdout.take().unwrap();
        let (tx, replies) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            while let Ok(Some(bytes)) = frame::read_frame(&mut output, REPLY_BYTES) {
                tx.send(serde_json::from_slice(&bytes).unwrap()).unwrap();
            }
        });
        Self {
            child,
            input,
            replies,
            reader: Some(reader),
            _root: root,
        }
    }
    fn send(&mut self, value: Value) {
        frame::write_frame(
            self.input.as_mut().unwrap(),
            &serde_json::to_vec(&value).unwrap(),
            REQUEST_BYTES,
        )
        .unwrap();
    }
    fn recv(&self) -> Value {
        self.replies
            .recv_timeout(Duration::from_secs(5))
            .expect("real helper reply")
    }
    fn exit(&mut self) {
        drop(self.input.take());
        for _ in 0..100 {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("helper did not stop after EOF");
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        drop(self.input.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
fn request(instance: &str, op: &str, ticket: &str, text: &str) -> Value {
    json!({"v":2,"ticket":ticket,"op":op,"instance":instance,"admission":"bounded_queue","queue_wait_ms":1000,"sources":[{"key":"code","generation":1,"source_version":1,"profile":"pi","fingerprint":Profile::resolve("pi").unwrap().fingerprint,"hint":{"language":"bash"},"text":text}]})
}
fn absolute_ranges(source: &Value) -> Vec<(u64, Value)> {
    let mut end = source["replace_from"].as_u64().unwrap();
    let (pairs, remainder) = source["runs"].as_array().unwrap().as_chunks::<2>();
    assert!(remainder.is_empty());
    let mut ranges = Vec::new();
    for pair in pairs {
        let length = pair[0].as_u64().unwrap();
        assert!(length > 0);
        end = end.checked_add(length).unwrap();
        ranges.push((end, pair[1].clone()));
    }
    assert_eq!(end, source["source_bytes"].as_u64().unwrap());
    ranges
}
#[test]
fn executable_negotiates_then_retains_only_stream_state_and_ends_on_eof() {
    let mut helper = Helper::new();
    helper.send(json!({"v":2,"ticket":"d","op":"describe"}));
    let descriptor = helper.recv();
    assert_eq!(descriptor["status"], "ok");
    assert_eq!(descriptor["body"]["capability"], "syntax-highlight/v2");
    assert_eq!(descriptor["body"]["limits"]["workers"], 1);
    let instance = descriptor["instance"].as_str().unwrap().to_owned();
    let text = "echo α\necho '";
    helper.send(request(&instance, "stream.open", "open", text));
    let opened = helper.recv();
    let first = &opened["body"]["sources"][0];
    assert_eq!(first["counters"]["committed_line_calls"], 1);
    let lease = first["lease"].as_str().unwrap();
    let revision = first["revision"].as_u64().unwrap();
    let base_bytes = first["source_bytes"].as_u64().unwrap();
    let suffix = "value'\n";
    helper.send(json!({"v":2,"ticket":"append","op":"stream.append","instance":instance,"admission":"bounded_queue","queue_wait_ms":1000,"key":"code","lease":lease,"generation":1,"source_version":2,"base_revision":revision,"base_bytes":base_bytes,"profile":"pi","fingerprint":Profile::resolve("pi").unwrap().fingerprint,"append":suffix,"final":true}));
    let appended = helper.recv();
    assert_eq!(appended["status"], "ok");
    let final_source = &appended["body"]["sources"][0];
    // Counters describe this operation, not cumulative lease history: only
    // the newly completed second line is parsed, never the committed first.
    assert_eq!(final_source["counters"]["committed_line_calls"], 1);
    assert_eq!(
        final_source["source_bytes"],
        (text.len() + suffix.len()) as u32
    );
    assert_eq!(final_source["complete"], true);
    helper.send(request(
        &instance,
        "highlight",
        "shot",
        &format!("{text}{suffix}"),
    ));
    let shot = helper.recv();
    assert_eq!(shot["status"], "ok");
    assert_eq!(shot["body"]["sources"][0]["styles"], final_source["styles"]);
    assert_eq!(
        shot["body"]["sources"][0]["counters"]["committed_line_calls"],
        2
    );
    let boundary = final_source["replace_from"].as_u64().unwrap();
    let mut merged: Vec<Value> = Vec::new();
    for (end, style) in absolute_ranges(first) {
        if merged
            .last()
            .and_then(|_| merged.get(merged.len() - 2))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= boundary
        {
            break;
        }
        merged.extend([json!(end.min(boundary)), style]);
    }
    for (end, style) in absolute_ranges(final_source) {
        if merged.last() == Some(&style) {
            let last_end = merged.len() - 2;
            merged[last_end] = json!(end);
        } else {
            merged.extend([json!(end), style]);
        }
    }
    // Compare the full merged classification in the actual v2 wire format,
    // preserving every style and byte boundary, not just total coverage.
    let mut previous = 0;
    for pair in merged.as_chunks_mut::<2>().0 {
        let end = pair[0].as_u64().unwrap();
        pair[0] = json!(end - previous);
        previous = end;
    }
    assert_eq!(shot["body"]["sources"][0]["runs"], json!(merged));
    helper.send(json!({"v":2,"ticket":"old","op":"stream.append","instance":instance,"admission":"bounded_queue","queue_wait_ms":1000,"key":"code","lease":lease,"generation":1,"source_version":3,"base_revision":final_source["revision"],"base_bytes":final_source["source_bytes"],"profile":"pi","fingerprint":Profile::resolve("pi").unwrap().fingerprint,"append":"x","final":false}));
    let stale = helper.recv();
    assert_eq!(stale["error"]["code"], "restart_required");
    assert_eq!(stale["error"]["execution"], "not_started");
    helper.exit();
}
#[test]
fn bad_declared_pipe_length_is_rejected_before_body_and_helper_incarnations_differ() {
    let mut first = Helper::new();
    let mut second = Helper::new();
    first.send(json!({"v":2,"ticket":"one","op":"describe"}));
    second.send(json!({"v":2,"ticket":"two","op":"describe"}));
    assert_ne!(first.recv()["instance"], second.recv()["instance"]);
    first
        .input
        .as_mut()
        .unwrap()
        .write_all(&((REQUEST_BYTES + 1) as u32).to_be_bytes())
        .unwrap();
    drop(first.input.take());
    for _ in 0..100 {
        if let Some(status) = first.child.try_wait().unwrap() {
            assert!(!status.success());
            second.exit();
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("oversize header waited for a body");
}
