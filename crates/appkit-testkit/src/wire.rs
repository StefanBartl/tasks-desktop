//! Requests as raw bytes, and answers read back from the socket.

use std::net::SocketAddr;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// What came back: the parts of the answer, and the bytes as text.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub raw: String,
}

impl Reply {
    /// A header by name, whatever the case.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The body as JSON.
    ///
    /// # Panics
    ///
    /// When the body is not JSON (a test then shows the raw answer).
    #[must_use]
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {:?}", self.raw))
    }
}

/// Read the parts of an answer.
#[must_use]
pub fn parse(bytes: &[u8]) -> Reply {
    let raw = String::from_utf8_lossy(bytes).into_owned();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    // A chunked body is shown as it came; the tests that read JSON use
    // identity bodies (axum sets Content-Length for them).
    Reply {
        status,
        headers,
        body: body.to_owned(),
        raw,
    }
}

/// Build one request. Every header is written by the test.
#[must_use]
pub fn request(method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("{method} {path} HTTP/1.1\r\n").into_bytes();
    for (k, v) in headers {
        out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out.extend_from_slice(body);
    out
}

/// Send the bytes and read the answer to the end (at most five seconds).
///
/// # Panics
///
/// When the connection cannot be made.
pub async fn send(addr: SocketAddr, bytes: Vec<u8>) -> Reply {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let _ = stream.write_all(&bytes).await;
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut buf)).await;
    parse(&buf)
}
