# Test-only TLS certificate

`test-only-cert.pem` and `test-only-key.pem` are a self-signed certificate for `fixture.test` and
`*.fixture.test`, valid until 2126. The crawler's integration tests serve a fixture site over HTTPS with it
and trust it explicitly, to prove that the certificate is checked against the **name** in the URL even though
the crawler connects to a pre-checked IP address.

The key protects nothing: it exists only in this repository, is never loaded by the app, and no real host uses it.

To make a new pair (the config file only sets the subject):

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-only-key.pem -out test-only-cert.pem -days 36500 \
  -addext "subjectAltName=DNS:fixture.test,DNS:*.fixture.test"
```
