use occipital::frame::{read_frame, write_frame};
use std::io::{self, Cursor, Read};
struct Fragmented {
    input: Cursor<Vec<u8>>,
    read: usize,
}
impl Read for Fragmented {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let length = buf.len().min(1);
        let count = self.input.read(&mut buf[..length])?;
        self.read += count;
        Ok(count)
    }
}
#[test]
fn consecutive_utf8_messages_survive_arbitrary_header_and_body_fragmentation() {
    let payloads = ["{\"text\":\"λ🧪\"}", "{\"ticket\":\"next\"}"];
    let mut bytes = Vec::new();
    for payload in payloads {
        write_frame(&mut bytes, payload.as_bytes(), 64).unwrap();
    }
    let mut fragmented = Fragmented {
        input: Cursor::new(bytes),
        read: 0,
    };
    for payload in payloads {
        assert_eq!(
            read_frame(&mut fragmented, 64).unwrap().unwrap(),
            payload.as_bytes()
        );
    }
    assert!(read_frame(&mut fragmented, 64).unwrap().is_none());
}
#[test]
fn oversized_declaration_does_not_read_or_allocate_a_body() {
    let mut input = Fragmented {
        input: Cursor::new([257u32.to_be_bytes().as_slice(), &vec![b'x'; 257]].concat()),
        read: 0,
    };
    assert_eq!(
        read_frame(&mut input, 256).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(input.read, 4);
}
#[test]
fn clean_eof_is_distinct_from_partial_header_and_partial_body() {
    assert!(read_frame(&mut Cursor::new(Vec::<u8>::new()), 256)
        .unwrap()
        .is_none());
    for bytes in [vec![0], vec![0, 0], vec![0, 0, 0], vec![0, 0, 0, 2, b'{']] {
        assert_eq!(
            read_frame(&mut Cursor::new(bytes), 256).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    assert_eq!(
        read_frame(&mut Cursor::new(0u32.to_be_bytes()), 256)
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
}
#[test]
fn inclusive_cap_and_rejected_writes_do_not_publish_partial_frames() {
    let mut output = Vec::new();
    write_frame(&mut output, &vec![b'x'; 256], 256).unwrap();
    assert_eq!(&output[..4], &256u32.to_be_bytes());
    assert_eq!(
        read_frame(&mut Cursor::new(&output), 256)
            .unwrap()
            .unwrap()
            .len(),
        256
    );
    output.clear();
    assert!(write_frame(&mut output, &vec![b'x'; 257], 256).is_err());
    assert!(output.is_empty());
    assert!(write_frame(&mut output, &[], 256).is_err());
    assert!(output.is_empty());
}
