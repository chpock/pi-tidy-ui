//! Actual allocator observations at payload destruction, not only end-state counters.
use occipital::{credit::Budget, scheduler::Scheduler, semantic_engine::Limits};
use serde_json::json;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::{
        atomic::{AtomicPtr, AtomicUsize, Ordering},
        Mutex,
    },
};

struct ObservedAllocator;
#[global_allocator]
static ALLOCATOR: ObservedAllocator = ObservedAllocator;
static SERIAL: Mutex<()> = Mutex::new(());
static BUDGET: AtomicPtr<Budget> = AtomicPtr::new(std::ptr::null_mut());
static TARGET: AtomicUsize = AtomicUsize::new(0);
static SIZE: AtomicUsize = AtomicUsize::new(0);
static DROPPED: AtomicUsize = AtomicUsize::new(usize::MAX);
static LAST_LARGE_PTR: AtomicUsize = AtomicUsize::new(0);
static LAST_LARGE_BYTES: AtomicUsize = AtomicUsize::new(0);
fn record_large_allocation(ptr: *mut u8, bytes: usize) {
    if bytes >= 64 << 10 && !BUDGET.load(Ordering::Acquire).is_null() {
        LAST_LARGE_PTR.store(ptr as usize, Ordering::Release);
        LAST_LARGE_BYTES.store(bytes, Ordering::Release);
    }
}
unsafe impl GlobalAlloc for ObservedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: delegate unchanged allocator contract.
        let ptr = unsafe { System.alloc(layout) };
        record_large_allocation(ptr, layout.size());
        if SIZE.load(Ordering::Acquire) == layout.size() {
            let _ = TARGET.compare_exchange(0, ptr as usize, Ordering::AcqRel, Ordering::Acquire);
        }
        ptr
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        // SAFETY: delegate unchanged allocator contract.
        let result = unsafe { System.realloc(ptr, layout, size) };
        record_large_allocation(result, size);
        if SIZE.load(Ordering::Acquire) == size {
            let _ =
                TARGET.compare_exchange(0, result as usize, Ordering::AcqRel, Ordering::Acquire);
        }
        result
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if TARGET
            .compare_exchange(ptr as usize, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let budget = BUDGET.load(Ordering::Acquire);
            if !budget.is_null() {
                // SAFETY: Probe borrows the stable caller Budget; serialized tests
                // disarm before that borrow ends. snapshot does not allocate.
                DROPPED.store(unsafe { &*budget }.snapshot().bytes, Ordering::Release);
            }
        }
        // SAFETY: delegate unchanged allocator contract.
        unsafe { System.dealloc(ptr, layout) };
    }
}
struct Probe<'a>(&'a Budget);
impl<'a> Probe<'a> {
    fn allocation(budget: &'a Budget, size: usize) -> Self {
        Self::arm(budget, 0, size)
    }
    fn arm(budget: &'a Budget, ptr: usize, size: usize) -> Self {
        DROPPED.store(usize::MAX, Ordering::Release);
        LAST_LARGE_PTR.store(0, Ordering::Release);
        LAST_LARGE_BYTES.store(0, Ordering::Release);
        BUDGET.store(std::ptr::from_ref(budget).cast_mut(), Ordering::Release);
        TARGET.store(ptr, Ordering::Release);
        SIZE.store(size, Ordering::Release);
        Self(budget)
    }
    fn observed(&self) -> usize {
        let _ = self.0;
        DROPPED.load(Ordering::Acquire)
    }
}
impl Drop for Probe<'_> {
    fn drop(&mut self) {
        SIZE.store(0, Ordering::Release);
        TARGET.store(0, Ordering::Release);
        BUDGET.store(std::ptr::null_mut(), Ordering::Release);
    }
}
fn request(ticket: &str, text: &str, queued: bool) -> Vec<u8> {
    let mut value = json!({"v":3,"ticket":ticket,"op":"stream.open","instance":"boot","admission":if queued {"bounded_queue"} else {"try_now"},"sources":[{"key":ticket,"generation":1,"source_version":1,"hint":{"language":"typescript"},"text":text}]});
    if queued {
        value["queue_wait_ms"] = json!(1000);
    }
    serde_json::to_vec(&value).unwrap()
}
#[test]
fn rejected_source_is_destroyed_before_releasing_its_credit() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let budget = Budget::new(
        occipital::limits::DATA_BYTES,
        occipital::limits::DATA_JOBS,
        occipital::limits::DATA_PER_ROUTE,
    );
    let mut worker = Scheduler::new("boot".into(), Limits::default(), budget.clone());
    worker.bind("a").unwrap();
    worker.bind("b").unwrap();
    let active = worker
        .submit("a", request("active", "echo x", true), 0)
        .unwrap();
    let text = "x".repeat(occipital::limits::SOURCE_BYTES);
    let len = text.len();
    let rejected = request("rejected", &text, false);
    // Observe the production decoder's owned source allocation, not a caller-
    // constructed legacy Request that bypasses the active raw admission path.
    let probe = Probe::allocation(&budget, len);
    let mut ticket = worker.submit("b", rejected, 0).unwrap();
    let delivery = ticket.try_take().unwrap().unwrap();
    let body: serde_json::Value = serde_json::from_slice(delivery.bytes()).unwrap();
    assert_eq!(body["error"]["code"], "busy");
    assert_ne!(
        probe.observed(),
        usize::MAX,
        "actual source destructor was not observed"
    );
    assert!(
        probe.observed() >= len,
        "source payload deallocated after its reservation had already shrunk: {} < {len}",
        probe.observed()
    );
    drop(probe);
    delivery.commit();
    drop(active);
    worker.tick(0);
    worker.close("a");
    worker.close("b");
    assert_eq!(budget.snapshot().bytes, 0);
}
#[test]
fn structured_runs_are_destroyed_before_credit_reduces_to_encoded_bytes() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let budget = Budget::new(
        occipital::limits::DATA_BYTES,
        occipital::limits::DATA_JOBS,
        occipital::limits::DATA_PER_ROUTE,
    );
    let mut worker = Scheduler::new("boot".into(), Limits::default(), budget.clone());
    worker.bind("a").unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&request(
        "large",
        &"const x: number = 1234;\n".repeat(2000),
        true,
    ))
    .unwrap();
    value["op"] = json!("highlight");
    let source = serde_json::to_vec(&value).unwrap();
    let structured = 32768 * std::mem::size_of::<[u32; 2]>();
    let probe = Probe::allocation(&budget, structured);
    let mut ticket = worker.submit("a", source, 0).unwrap();
    for _ in 0..2000 {
        worker.tick(0);
    }
    let delivery = ticket.try_take().unwrap().unwrap();
    // Length-style JSON is smaller than the old endpoint representation. Bind
    // the real final wire allocation by pointer instead of guessing its capacity
    // from the old format; the lifetime ordering assertion remains unchanged.
    assert_eq!(
        LAST_LARGE_PTR.load(Ordering::Acquire),
        delivery.bytes().as_ptr() as usize
    );
    let encoded_capacity = LAST_LARGE_BYTES.load(Ordering::Acquire);
    assert!(encoded_capacity >= delivery.bytes().len() && encoded_capacity >= 64 << 10);
    assert_ne!(
        probe.observed(),
        usize::MAX,
        "actual final run-container destructor was not observed"
    );
    assert!(
        probe.observed() >= structured + encoded_capacity,
        "structured+encoded payloads survived a premature credit reduction: {}",
        probe.observed()
    );
    drop(probe);
    delivery.commit();
    worker.tick(0);
    worker.close("a");
    worker.close("b");
    assert_eq!(budget.snapshot().bytes, 0);
}
