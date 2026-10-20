import { isIP } from 'node:net';

const PRIVATE_V4 = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (carrier-grade NAT)
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 (link-local, cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
] as const;

function isPrivateIPv4(address: string): boolean {
  const n = address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  return PRIVATE_V4.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return true;
  if (isIP(host) === 4) return isPrivateIPv4(host);
  if (isIP(host) === 6) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true; // unique local, link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    return mapped?.[1] ? isPrivateIPv4(mapped[1]) : false;
  }
  return false;
}

/**
 * Webhook URLs are fetched by the server, so in production they must be public HTTPS
 * addresses. Otherwise anyone could make the API call internal services (SSRF).
 * Returns a reason when the URL is not allowed, or null when it is.
 */
export function webhookUrlProblem(raw: string, { allowPrivate }: { allowPrivate: boolean }) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be a valid URL';
  }
  if (url.username || url.password) return 'must not contain credentials';
  if (allowPrivate) {
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'must use http or https';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (isPrivateHost(url.hostname)) return 'must point to a public host';
  return null;
}
