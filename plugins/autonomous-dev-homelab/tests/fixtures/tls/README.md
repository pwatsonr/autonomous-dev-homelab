# Pre-generated self-signed TLS fixture

`localhost.crt` and `localhost.key` are a self-signed RSA-2048 cert + key
pair used by `tests/helpers/fixture-server.ts` when starting an HTTPS
fixture in integration tests.

- Subject: CN=localhost
- SAN: DNS:localhost, IP:127.0.0.1
- Validity: 100 years from generation
- Generated: 2026-05-02 (expires ~2126-05)

Regenerate with:

```sh
openssl req -x509 -newkey rsa:2048 \
  -keyout localhost.key -out localhost.crt \
  -sha256 -days 36500 -nodes \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Per SPEC-001-1-05: pre-generation trades a few KB of repo bloat for major
speed and determinism gains versus generating per-test-run.
