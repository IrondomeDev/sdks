use irondome_sdk::{Client, Error, Options};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct Fixture {
    child: Child,
    url: String,
    certificate: Vec<u8>,
}
impl Fixture {
    fn start() -> Self {
        let python = std::env::var_os("PYTHON").unwrap_or_else(|| {
            if cfg!(windows) {
                "python".into()
            } else {
                "python3".into()
            }
        });
        let mut child = Command::new(python)
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../testing/server.py"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let data: serde_json::Value = serde_json::from_str(&line).unwrap();
        Self {
            child,
            url: data["url"].as_str().unwrap().to_owned(),
            certificate: std::fs::read(data["ca_file"].as_str().unwrap()).unwrap(),
        }
    }
    fn client(&self, timeout: Duration) -> Client {
        Client::new(
            "test-key",
            &self.url,
            Options {
                timeout,
                additional_root_certificates: vec![self.certificate.clone()],
                ..Options::default()
            },
        )
        .unwrap()
    }
    async fn checks(&self) -> u64 {
        let ca = reqwest::Certificate::from_pem(&self.certificate).unwrap();
        let http = reqwest::Client::builder()
            .tls_certs_merge([ca])
            .no_proxy()
            .build()
            .unwrap();
        let body = http
            .get(format!("{}/_stats", self.url))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["checks_seen"]
            .as_u64()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

#[tokio::test]
async fn reuse_and_no_replay() {
    let fixture = Fixture::start();
    let client = fixture.client(Duration::from_secs(5));
    let health = client.warmup().await.unwrap();
    let first = client.check("é@example.com").await.unwrap();
    let second = client.clone().check("person@example.com").await.unwrap();
    let connection =
        |id: &Option<String>| id.as_ref().unwrap().split('-').next().unwrap().to_owned();
    assert_eq!(
        connection(&health.request_id),
        connection(&first.request_id)
    );
    assert_eq!(
        connection(&first.request_id),
        connection(&second.request_id)
    );
    assert!(!format!("{client:?}").contains("test-key"));
    for email in [
        "redirect@example.com",
        "unavailable@example.com",
        "truncated@example.com",
    ] {
        let before = fixture.checks().await;
        assert!(client.check(email).await.is_err());
        assert_eq!(fixture.checks().await, before + 1);
    }
    match client.check("unavailable@example.com").await.unwrap_err() {
        Error::Api {
            status,
            code,
            retry_after,
            ..
        } => {
            assert_eq!(status, 503);
            assert_eq!(code, "service_unavailable");
            assert_eq!(retry_after, Some(Duration::from_secs(5)));
        }
        other => panic!("unexpected safe error: {other}"),
    }
    client.check("cookie@example.com").await.unwrap();
    client.check("person@example.com").await.unwrap();
}

#[tokio::test]
async fn verified_tls_and_protocol_limits() {
    let fixture = Fixture::start();
    let untrusted = Client::new("test-key", &fixture.url, Options::default()).unwrap();
    assert!(matches!(untrusted.warmup().await, Err(Error::Transport)));
    let wrong_host = Client::new(
        "test-key",
        &fixture.url.replace("localhost", "127.0.0.1"),
        Options {
            additional_root_certificates: vec![fixture.certificate.clone()],
            ..Options::default()
        },
    )
    .unwrap();
    assert!(matches!(wrong_host.warmup().await, Err(Error::Transport)));
    let client = fixture.client(Duration::from_secs(5));
    for email in [
        "oversized@example.com",
        "chunked-oversized@example.com",
        "malformed@example.com",
        "invalid-schema@example.com",
    ] {
        assert!(matches!(client.check(email).await, Err(Error::Protocol)));
    }
}

#[tokio::test]
async fn deadlines_and_drop_cancellation_release_capacity() {
    let fixture = Fixture::start();
    let client = fixture.client(Duration::from_millis(40));
    for email in ["slow@example.com", "slow-body@example.com"] {
        assert!(matches!(client.check(email).await, Err(Error::Timeout)));
    }
    let client = fixture.client(Duration::from_secs(5));
    let copy = client.clone();
    let task = tokio::spawn(async move { copy.check("slow@example.com").await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    client.warmup().await.unwrap();
}

#[test]
fn configuration_is_bounded_and_does_not_include_secrets() {
    for key in ["", "has space", "bad\r\nkey", "é"] {
        assert!(matches!(
            Client::new(key, "https://example.com", Options::default()),
            Err(Error::Configuration)
        ));
    }
    assert!(matches!(
        Client::new(
            "test-key",
            "https://example.com",
            Options {
                timeout: Duration::ZERO,
                ..Options::default()
            }
        ),
        Err(Error::Configuration)
    ));
}
