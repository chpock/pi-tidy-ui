//! Direct-pipe framing: four big-endian length bytes then exact UTF-8 JSON bytes.
//! Shared mode uses Subconscious framing around the same application JSON body.
use std::io::{self, Read, Write};

pub fn read_frame<R: Read>(reader: &mut R, cap: usize) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > cap {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame length limit",
        ));
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| io::Error::new(io::ErrorKind::OutOfMemory, "frame allocation"))?;
    bytes.resize(length, 0);
    reader.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}
pub fn write_frame<W: Write>(writer: &mut W, bytes: &[u8], cap: usize) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > cap {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame length limit",
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame length limit"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}
