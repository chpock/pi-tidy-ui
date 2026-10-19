use occipital::{credit::Budget, semantic_reply};

#[test]
fn encoded_buffer_capacity_is_reserved_in_the_same_live_job_before_growth() {
    let budget = Budget::new(1 << 20, 2, 2);
    let mut credit = budget.reserve(Some("route"), 512).unwrap();
    credit.started();
    let reply = semantic_reply::ok("ticket", "instance", vec![42u32; 1024]);
    let encoded = reply.encode_with_credit(&mut credit, 64 << 10).unwrap();
    assert_eq!(encoded, reply.encode().unwrap());
    assert_eq!(budget.snapshot().bytes, 512 + encoded.capacity());
    assert_eq!(budget.snapshot().jobs, 1);
    drop(encoded);
    assert_eq!(budget.snapshot().jobs, 1);
    drop(credit);
    assert_eq!(budget.snapshot().bytes, 0);
    assert_eq!(budget.snapshot().jobs, 0);
}

#[test]
fn pool_pressure_and_encoded_frame_overflow_have_distinct_failures_and_keep_credit_until_drain() {
    for (pool, cap, expected) in [(128, 4096, "data_limit"), (1 << 20, 128, "reply_limit")] {
        let budget = Budget::new(pool, 2, 2);
        let mut credit = budget.reserve(Some("route"), 0).unwrap();
        credit.started();
        let reply = semantic_reply::ok("ticket", "instance", vec![42u32; 1024]);
        let error = reply.encode_with_credit(&mut credit, cap).unwrap_err();
        assert_eq!(error.code, expected);
        assert!(error.started);
        assert!(budget.snapshot().bytes <= pool);
        assert_eq!(budget.snapshot().jobs, 1);
        drop(credit);
        assert_eq!(budget.snapshot().bytes, 0);
        assert_eq!(budget.snapshot().jobs, 0);
    }
}
