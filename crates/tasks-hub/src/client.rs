//! A tiny HTTP/1.1 client for the two things the hub's own programs do:
//! ask a running hub who it is, and ask it for a pairing code.
//!
//! It speaks to `127.0.0.1` only, sends `Connection: close`, and reads at
//! most 64 KiB. There is no TLS, no redirect, no proxy: nothing a program
//! that sends a credential to a local port should have.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const MAX_REPLY_BYTES: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);

/// A status code and the body text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// Send one request to the hub on `port`.
///
/// # Errors
///
/// I/O errors, a time-out, a reply over the size limit or not HTTP.
pub async fn request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> io::Result<Reply> {
    let mut text = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    for (name, value) in headers {
        // A header value with a line break would be a second header.
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a header holds a line break",
            ));
        }
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    text.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ));

    let exchange = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
        stream.write_all(text.as_bytes()).await?;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            if buf.len() + n > MAX_REPLY_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "the reply is larger than expected",
                ));
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok::<_, io::Error>(buf)
    };
    let bytes = tokio::time::timeout(TIMEOUT, exchange)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "the hub did not answer"))??;
    parse(&bytes)
}

fn parse(bytes: &[u8]) -> io::Result<Reply> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "not an HTTP reply");
    let text = std::str::from_utf8(bytes).map_err(|_| bad())?;
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(bad)?;
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(bad)?;
    Ok(Reply {
        status,
        body: body.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_parsed() {
        let r = parse(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}").unwrap();
        assert_eq!(
            r,
            Reply {
                status: 200,
                body: "{}".to_owned()
            }
        );
    }

    #[test]
    fn nonsense_is_not_a_reply() {
        assert!(parse(b"").is_err());
        assert!(parse(b"hello").is_err());
        assert!(parse(b"HTTP/1.1 abc\r\n\r\n").is_err());
        assert!(parse(&[0xff, 0xfe, b'\r', b'\n', b'\r', b'\n']).is_err());
    }

    #[tokio::test]
    async fn a_header_with_a_line_break_is_refused() {
        let err = request(1, "GET", "/", &[("X", "a\r\nInjected: 1")], "")
            .await
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }
}
