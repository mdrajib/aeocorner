import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A minimal zip writer: enough to hand a customer the WordPress plugin as one file (a zip of its folder), with no
 * dependency. Entries are deflated, names are UTF-8, there is no encryption, no zip64 and no data descriptors, so the
 * archive is limited to 65,535 files and 4 GB, far beyond a plugin. Dates are fixed (1980-01-01) so the same files
 * always give the same bytes, which makes the download cacheable and testable.
 */

const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;

/** @param {{ name: string, data: Buffer|string }[]} entries  names use "/" and never start with one */
export function createZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (
      name.length === 0 ||
      name.length > 65_535 ||
      entry.name.startsWith('/') ||
      entry.name.includes('..')
    ) {
      throw new RangeError(`Not a usable file name in a zip: ${entry.name}`);
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(0x031e, 4); // made by: Unix, spec 3.0
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE((0o100644 * 65_536) >>> 0, 38); // external attributes: a regular file, rw-r--r--
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
