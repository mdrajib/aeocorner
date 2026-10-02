import http from 'node:http';

/**
 * A tiny S3 server on this machine, so the real AWS S3 client can be tested against something without Docker or
 * a cloud account. It speaks path-style S3: PUT, GET, HEAD and DELETE on /<bucket>/<key>.
 *
 * It does NOT check request signatures (that would be testing the AWS library, not our code), but it does require
 * that the request carries one, and it records every request so a test can assert what was sent. It is no proof
 * that DigitalOcean Spaces accepts our requests: that is checked once, by hand, against a real bucket.
 */
export async function startS3Stub({ bucket = 'test-bucket', accessKeyId = 'TESTKEY' } = {}) {
  const objects = new Map();
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://stub');
      const [, requestBucket, ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));
      requests.push({
        method: req.method,
        bucket: requestBucket,
        key,
        headers: req.headers,
        bytes: body.length,
      });

      const fail = (status, code) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
        );
      };
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`))
        return fail(403, 'AccessDenied');
      if (requestBucket !== bucket) return fail(404, 'NoSuchBucket');

      if (req.method === 'PUT') {
        // The AWS client's newer checksum framing is not understood by every S3-compatible service.
        if (
          /aws-chunked/i.test(String(req.headers['content-encoding'] ?? '')) ||
          req.headers['x-amz-trailer']
        ) {
          return fail(400, 'InvalidRequest');
        }
        const metadata = Object.fromEntries(
          Object.entries(req.headers)
            .filter(([name]) => name.startsWith('x-amz-meta-'))
            .map(([name, value]) => [name.slice('x-amz-meta-'.length), value]),
        );
        objects.set(key, { body, contentType: req.headers['content-type'], metadata });
        res.writeHead(200, { etag: '"stub"' });
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const object = objects.get(key);
        if (!object) {
          if (req.method === 'HEAD') {
            res.writeHead(404);
            return res.end();
          }
          return fail(404, 'NoSuchKey');
        }
        res.writeHead(200, {
          'content-type': object.contentType ?? 'application/octet-stream',
          'content-length': object.body.length,
          etag: '"stub"',
          ...Object.fromEntries(
            Object.entries(object.metadata).map(([k, v]) => [`x-amz-meta-${k}`, v]),
          ),
        });
        return res.end(req.method === 'HEAD' ? undefined : object.body);
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      return fail(405, 'MethodNotAllowed');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    accessKeyId,
    secretAccessKey: 'testsecret',
    region: 'test-1',
    objects,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
