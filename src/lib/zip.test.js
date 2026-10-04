import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';
import { createZip } from './zip.js';

/** A reader for what createZip writes, using only the central directory (as real unzip tools do). */
function readZip(buffer) {
  const endAt = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(endAt), 0x06054b50, 'end of central directory');
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, 'central entry');
    const method = buffer.readUInt16LE(at + 10);
    const checksum = buffer.readUInt32LE(at + 16);
    const packedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(localAt), 0x04034b50, 'local header');
    const start =
      localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const packed = buffer.subarray(start, start + packedSize);
    const data = method === 8 ? inflateRawSync(packed) : packed;
    assert.equal(data.length, size, `${name}: size`);
    assert.equal(crc32(data), checksum, `${name}: checksum`);
    files[name] = data.toString('utf8');
    at += 46 + nameLength;
  }
  return files;
}

test('what goes in comes out: names, text and checksums, including non-ASCII and empty files', () => {
  const zip = createZip([
    { name: 'plugin/a.php', data: '<?php echo "hello";\n'.repeat(200) },
    { name: 'plugin/includes/b.php', data: Buffer.from('short') },
    { name: 'plugin/readme.txt', data: 'Café — “quotes” ✓' },
    { name: 'plugin/empty.txt', data: '' },
  ]);
  const files = readZip(zip);
  assert.deepEqual(Object.keys(files), [
    'plugin/a.php',
    'plugin/includes/b.php',
    'plugin/readme.txt',
    'plugin/empty.txt',
  ]);
  assert.equal(files['plugin/a.php'], '<?php echo "hello";\n'.repeat(200));
  assert.equal(files['plugin/readme.txt'], 'Café — “quotes” ✓');
  assert.equal(files['plugin/empty.txt'], '');
  assert.ok(zip.length < 2_000, 'repetitive text is compressed');
});

test('the same files always give the same bytes, so the download can be cached', () => {
  const entries = [{ name: 'x/y.txt', data: 'same' }];
  assert.deepEqual(createZip(entries), createZip(entries));
});

test('names that could escape the folder, or are empty, are refused', () => {
  for (const name of ['', '/etc/passwd', '../x', 'a/../../b']) {
    assert.throws(() => createZip([{ name, data: 'x' }]), RangeError, name);
  }
});

test('an empty archive is valid', () => {
  assert.deepEqual(readZip(createZip([])), {});
});
