import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The one refusal a worker states when a configured endpoint points at
 * infrastructure no business source may ever read.
 */
export const EGRESS_TARGET_REFUSED = 'ACQUISITION_TARGET_REFUSED';

/**
 * Host names that only ever answer the cloud metadata service. They are refused
 * by name, so a deployment never depends on how a name currently resolves.
 */
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.azure.internal',
]);

/** Single addresses that are a metadata service rather than a business endpoint. */
const METADATA_ADDRESSES = new Set([
  '100.100.100.200',
  '168.63.129.16',
  '169.254.169.254',
  '169.254.170.2',
  'fd00:ec2::254',
]);

function hostnameOf(parsed: URL): string {
  return parsed.hostname.replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.$/u, '').toLowerCase();
}

function ipv4Blocked(address: string): boolean {
  const [a, b] = address.split('.').map((part) => Number(part));
  if (a === undefined || b === undefined) return false;
  // 0.0.0.0/8 names this host, and 169.254.0.0/16 is link-local, which every
  // cloud holds its metadata service on.
  if (a === 0) return true;
  return a === 169 && b === 254;
}

/** The IPv4 an IPv4-mapped IPv6 address carries, if it carries one. */
function mappedIPv4(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address);
  if (match?.[1] !== undefined) return match[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (hex?.[1] === undefined || hex[2] === undefined) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function ipv6Blocked(address: string): boolean {
  const mapped = mappedIPv4(address);
  if (mapped !== null) return ipv4Blocked(mapped);
  const first = Number.parseInt(address.split(':')[0] ?? '', 16);
  if (!Number.isFinite(first)) return false;
  // fe80::/10 is link-local, which covers the AWS IPv6 metadata endpoint.
  return (first & 0xffc0) === 0xfe80;
}

function addressBlocked(address: string): boolean {
  if (METADATA_ADDRESSES.has(address)) return true;
  const version = isIP(address);
  if (version === 4) return ipv4Blocked(address);
  if (version === 6) return ipv6Blocked(address);
  return false;
}

/**
 * Proves one configured endpoint may be read by a constrained worker.
 *
 * A redirect is refused by the caller rather than followed, and every request
 * revalidates its own target, so a name that starts resolving into link-local or
 * metadata space is refused at the moment it would be read. Returning null means
 * the endpoint is an ordinary http(s) target.
 */
export async function egressRefusal(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = hostnameOf(parsed);
  if (hostname === '' || METADATA_HOSTNAMES.has(hostname)) {
    return EGRESS_TARGET_REFUSED;
  }
  if (isIP(hostname) !== 0) {
    return addressBlocked(hostname) ? EGRESS_TARGET_REFUSED : null;
  }
  // A name is resolved before it is read: any address it answers with that is
  // link-local or a metadata service refuses the whole target.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    // A name that cannot resolve is refused by the request itself, not here.
    return null;
  }
  return addresses.some((entry) => addressBlocked(entry.address)) ? EGRESS_TARGET_REFUSED : null;
}
