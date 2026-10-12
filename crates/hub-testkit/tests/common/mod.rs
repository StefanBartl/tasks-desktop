//! Helpers the event tests share.

use std::net::SocketAddr;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// An open event stream, read the way a browser's `fetch` would.
pub struct Sse {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl Sse {
    /// Open a stream. `Err` carries the status of a refusal.
    pub async fn open(addr: SocketAddr, token: Option<&str>) -> Result<Self, u16> {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let mut request = format!(
            "GET /api/tasks/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: text/event-stream\r\n",
            addr.port()
        );
        if let Some(t) = token {
            request.push_str(&format!("Authorization: Bearer {t}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
                .await
                .expect("a reply")
                .unwrap();
            assert!(n > 0, "closed before a reply");
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let status: u16 = head.split(' ').nth(1).unwrap().parse().unwrap();
        if status != 200 {
            return Err(status);
        }
        assert!(head.to_lowercase().contains("text/event-stream"), "{head}");
        let rest = buf.split_off(head_end + 4);
        Ok(Self { stream, buf: rest })
    }

    /// The next message of the stream, whole (one chunk is one message), or
    /// `None` when none came within `within`.
    pub async fn next(&mut self, within: Duration) -> Option<String> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            if let Some(message) = self.take_chunk() {
                return Some(message);
            }
            let mut chunk = [0u8; 4096];
            let read = tokio::time::timeout_at(deadline, self.stream.read(&mut chunk)).await;
            match read {
                Ok(Ok(n)) if n > 0 => self.buf.extend_from_slice(&chunk[..n]),
                _ => return None,
            }
        }
    }

    /// One chunk of chunked transfer encoding, if the buffer holds it whole.
    fn take_chunk(&mut self) -> Option<String> {
        let line_end = self.buf.windows(2).position(|w| w == b"\r\n")?;
        let size =
            usize::from_str_radix(std::str::from_utf8(&self.buf[..line_end]).ok()?, 16).ok()?;
        let start = line_end + 2;
        if self.buf.len() < start + size + 2 {
            return None;
        }
        let text = String::from_utf8_lossy(&self.buf[start..start + size]).into_owned();
        self.buf.drain(..start + size + 2);
        Some(text)
    }

    /// Did the server end the stream within `within`? What it still sends
    /// until then is read and dropped. The end of a chunked body is a chunk
    /// of size zero.
    // Shared by two test crates; not each of them ends a stream.
    #[allow(dead_code)]
    pub async fn ended(&mut self, within: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.next(left).await {
                Some(message) if message.is_empty() => return true,
                Some(_) => {}
                None => return false,
            }
        }
    }

    /// The next `tasks` event as JSON, skipping heartbeats.
    pub async fn next_change(&mut self, within: Duration) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            let message = self.next(left).await?;
            if let Some(data) = message
                .strip_prefix("event: tasks\ndata: ")
                .and_then(|m| m.strip_suffix("\n\n"))
            {
                return Some(serde_json::from_str(data).unwrap());
            }
        }
    }
}
