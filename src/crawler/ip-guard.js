import net from 'node:net';

/**
 * Which network addresses the crawler may connect to (MVP §11.2). The audit fetches whatever URL a stranger
 * types in, so anything that isn't an ordinary public internet address must be refused: this machine, the
 * office or data-centre network behind it, and above all the cloud "metadata" address that hands out credentials
 * to whoever asks from the inside.
 *
 * Pure functions only. The fetcher calls them on the address it is ABOUT to connect to, after DNS, and again on
 * every redirect.
 */

// [CIDR, why it is refused]. IPv4 first. Reserved and documentation ranges are included because no real website
// lives there, so a name that resolves to one is either broken or an attack.
const BLOCKED_V4 = [
  ['0.0.0.0/8', 'this-network'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'cgnat'], // carrier-grade NAT; also Alibaba Cloud's metadata address 100.100.100.200
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'], // includes the AWS/GCP/Azure/DigitalOcean metadata address 169.254.169.254
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'ietf-protocol'],
  ['192.0.2.0/24', 'documentation'],
  ['192.88.99.0/24', '6to4-relay'],
  ['192.168.0.0/16', 'private'],
  ['198.18.0.0/15', 'benchmarking'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'], // includes the broadcast address 255.255.255.255
];

// IPv6. Addresses that merely wrap an IPv4 address are checked as that IPv4 address (see `classifyIp`).
const BLOCKED_V6 = [
  ['::/96', 'unspecified-or-compatible'], // ::, ::1 and the deprecated IPv4-compatible form
  ['::ffff:0:0:0/96', 'ipv4-translated'],
  ['64:ff9b::/96', 'nat64'],
  ['64:ff9b:1::/48', 'nat64'],
  ['100::/64', 'discard'],
  ['2001::/23', 'ietf-protocol'], // includes Teredo (2001::/32)
  ['2001:db8::/32', 'documentation'],
  ['2002::/16', '6to4'],
  ['3fff::/20', 'documentation'],
  ['5f00::/16', 'segment-routing'],
  ['fc00::/7', 'private'], // unique-local; includes AWS's IPv6 metadata address fd00:ec2::254
  ['fe80::/10', 'link-local'],
  ['fec0::/10', 'site-local'],
  ['ff00::/8', 'multicast'],
];

function parseIpv4(text) {
  if (!net.isIPv4(text)) return null;
  return text.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function parseIpv6(text) {
  let s = String(text).toLowerCase();
  if (s.includes('%') || !net.isIPv6(s)) return null; // a zone id ("fe80::1%eth0") is link-local by definition

  // An embedded dotted IPv4 tail ("::ffff:1.2.3.4") becomes two ordinary groups.
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const tail = parseIpv4(s.slice(cut + 1));
    if (tail === null) return null;
    s = `${s.slice(0, cut + 1)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
  }

  const [head, rest, ...extra] = s.split('::');
  if (extra.length) return null;
  const groups = (part) => (part ? part.split(':') : []);
  const front = groups(head);
  const back = rest === undefined ? [] : groups(rest);
  const missing = 8 - front.length - back.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...front, ...Array(rest === undefined ? 0 : missing).fill('0'), ...back];
  return all.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

/** `"10.0.0.0/8"` -> a test for "is this number inside that block". */
function range(cidr, family) {
  const [address, prefixText] = cidr.split('/');
  const bits = family === 4 ? 32n : 128n;
  const shift = bits - BigInt(prefixText);
  const base = (family === 4 ? parseIpv4(address) : parseIpv6(address)) >> shift;
  return (value) => value >> shift === base;
}

const v4Ranges = BLOCKED_V4.map(([cidr, why]) => ({ why, contains: range(cidr, 4) }));
const v6Ranges = BLOCKED_V6.map(([cidr, why]) => ({ why, contains: range(cidr, 6) }));
const inMappedV4 = range('::ffff:0:0/96', 6);

/**
 * Is `text` an IP address we may connect to?
 * @returns {{ allowed: true } | { allowed: false, reason: string }}  `reason` is a short label for logs and results.
 */
export function classifyIp(text) {
  const v4 = parseIpv4(text);
  if (v4 !== null) return classifyV4(v4);

  const v6 = parseIpv6(text);
  if (v6 === null) return { allowed: false, reason: 'not-an-ip-address' };

  // "::ffff:127.0.0.1" is the IPv4 loopback address wearing an IPv6 costume. Judge the address inside.
  if (inMappedV4(v6)) return classifyV4(v6 & 0xffffffffn);

  const hit = v6Ranges.find((r) => r.contains(v6));
  return hit ? { allowed: false, reason: hit.why } : { allowed: true };
}

function classifyV4(value) {
  if (value === 0xa9fea9fen) return { allowed: false, reason: 'cloud-metadata' }; // 169.254.169.254
  const hit = v4Ranges.find((r) => r.contains(value));
  return hit ? { allowed: false, reason: hit.why } : { allowed: true };
}

export const isPublicIp = (text) => classifyIp(text).allowed;

/** The text between the brackets of an IPv6 URL host (`[::1]`), or the host unchanged. */
export function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** True if a URL host is an IP address written out (after the URL parser has normalised `0x7f.1`, `2130706433`...). */
export const isIpLiteral = (hostname) => net.isIP(unbracket(hostname)) !== 0;

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  '.lan',
];

/**
 * Names that mean "inside the network". DNS would normally send these to a private address and the IP check would
 * stop them anyway; this gives a clear reason first and doesn't depend on how the machine's resolver is set up.
 */
export function blockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === 'metadata' || host === 'metadata.google.internal') {
    return 'internal-hostname';
  }
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)) ? 'internal-hostname' : null;
}
