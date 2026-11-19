import { describe, it, expect } from 'vitest';
import {
  isBlockedAddress,
  assertPublicUrl,
  safeFetch,
  EgressBlockedError,
  readBodyCapped,
  type LookupAllFn,
} from './egressGuard.js';

const lookupTo = (addrs: Array<{ address: string; family: number }>): LookupAllFn =>
  async () => addrs;

describe('isBlockedAddress', () => {
  it('blocks loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.5.5.5')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
  });

  it('blocks RFC1918 private ranges', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
  });

  it('does not block public 172.x outside the /12', () => {
    expect(isBlockedAddress('172.15.0.1')).toBe(false);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
  });

  it('blocks link-local and IMDS', () => {
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('fd00:ec2::254')).toBe(true);
  });

  it('blocks CGNAT 100.64/10', () => {
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('100.127.255.255')).toBe(true);
    expect(isBlockedAddress('100.128.0.1')).toBe(false);
    expect(isBlockedAddress('100.63.0.1')).toBe(false);
  });

  it('blocks ULA and link-local IPv6', () => {
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('ff02::1')).toBe(true);
  });

  it('blocks unspecified and multicast IPv4', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('240.0.0.1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 pointing at private space', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows normal public addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('fails closed on garbage', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-https when allowHttp is false', async () => {
    await expect(
      assertPublicUrl('http://example.com', { lookup: lookupTo([{ address: '8.8.8.8', family: 4 }]) }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('allows http when allowHttp is true', async () => {
    const r = await assertPublicUrl('http://example.com', {
      allowHttp: true,
      lookup: lookupTo([{ address: '8.8.8.8', family: 4 }]),
    });
    expect(r.pinnedIp).toBe('8.8.8.8');
  });

  it('rejects unsupported schemes', async () => {
    await expect(assertPublicUrl('ftp://example.com')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('rejects the AWS metadata IP literal', async () => {
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      EgressBlockedError,
    );
  });

  it('rejects the GCP metadata hostname', async () => {
    await expect(
      assertPublicUrl('https://metadata.google.internal/computeMetadata/v1/', {
        lookup: lookupTo([{ address: '8.8.8.8', family: 4 }]),
      }),
    ).rejects.toThrow(EgressBlockedError);
  });

  it('rejects when DNS resolves to a private address (rebinding defense)', async () => {
    await expect(
      assertPublicUrl('https://evil.example.com', {
        lookup: lookupTo([{ address: '169.254.169.254', family: 4 }]),
      }),
    ).rejects.toThrow(EgressBlockedError);
  });

  it('rejects when ANY resolved address is private', async () => {
    await expect(
      assertPublicUrl('https://mixed.example.com', {
        lookup: lookupTo([
          { address: '8.8.8.8', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ]),
      }),
    ).rejects.toThrow(EgressBlockedError);
  });

  it('resolves a public URL and pins the first address', async () => {
    const r = await assertPublicUrl('https://good.example.com/path', {
      lookup: lookupTo([{ address: '93.184.216.34', family: 4 }]),
    });
    expect(r.pinnedIp).toBe('93.184.216.34');
    expect(r.url.hostname).toBe('good.example.com');
  });

  it('rejects malformed URLs', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(EgressBlockedError);
  });

  it('rejects when DNS fails', async () => {
    await expect(
      assertPublicUrl('https://nx.example.com', {
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toThrow(EgressBlockedError);
  });
});

describe('safeFetch', () => {
  it('refuses to fetch a blocked target before opening any socket', async () => {
    await expect(
      safeFetch(
        'https://evil.example.com',
        {},
        { lookup: lookupTo([{ address: '169.254.169.254', family: 4 }]) },
      ),
    ).rejects.toThrow(EgressBlockedError);
  });

  it('refuses the metadata IP literal', async () => {
    await expect(safeFetch('https://169.254.169.254/')).rejects.toThrow(EgressBlockedError);
  });
});

// Regression: the audit reproduced an IMDS/loopback SSRF bypass via
// IPv4-mapped IPv6 in hex/compressed form (`::ffff:a9fe:a9fe`), which the old
// string-prefix check only caught in dotted form. Classification is now done
// on the expanded 16 bytes, so every textual spelling is covered.
describe('isBlockedAddress — IPv6 forms that embed an IPv4 address', () => {
  it.each([
    ['::ffff:7f00:1', 'mapped loopback, hex'],
    ['::ffff:7f00:0001', 'mapped loopback, zero-padded hex'],
    ['::ffff:a9fe:a9fe', 'mapped IMDS 169.254.169.254, hex'],
    ['::FFFF:A9FE:A9FE', 'mapped IMDS, uppercase'],
    ['0:0:0:0:0:ffff:7f00:1', 'mapped loopback, uncompressed'],
    ['0:0:0:0:0:ffff:127.0.0.1', 'mapped loopback, uncompressed dotted'],
    ['::ffff:10.0.0.1', 'mapped RFC1918, dotted'],
    ['::ffff:c0a8:0101', 'mapped 192.168.1.1, hex'],
    ['[::ffff:a9fe:a9fe]', 'bracketed URL-host form'],
    ['::7f00:1', 'IPv4-compatible ::/96'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 well-known prefix → IMDS'],
    ['64:ff9b::7f00:1', 'NAT64 → loopback'],
    ['2002:7f00:0001::', '6to4 → loopback'],
    ['2002:a9fe:a9fe::1', '6to4 → IMDS'],
    ['fec0::1', 'site-local (deprecated)'],
    ['not-an-ip', 'unparseable → fail closed'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['::ffff:8.8.8.8', 'mapped public IPv4'],
    ['::ffff:808:808', 'mapped public IPv4, hex'],
    ['64:ff9b::808:808', 'NAT64 → public'],
    ['2002:0808:0808::1', '6to4 → public'],
    ['2606:4700:4700::1111', 'public IPv6 (Cloudflare DNS)'],
    ['2001:4860:4860::8888', 'public IPv6 (Google DNS)'],
    ['8.8.8.8', 'public IPv4'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('assertPublicUrl — DNS answers using embedded-IPv4 IPv6 forms', () => {
  it('rejects a hostname whose DNS answer is ::ffff:a9fe:a9fe (IMDS)', async () => {
    await expect(
      assertPublicUrl('https://evil.example.com/latest/meta-data/', {
        lookup: async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }],
      }),
    ).rejects.toThrow();
  });

  it('rejects a bracketed hex-mapped literal host', async () => {
    await expect(assertPublicUrl('https://[::ffff:a9fe:a9fe]/')).rejects.toThrow();
  });
});

describe('readBodyCapped — bounded streaming read (no full buffering)', () => {
  /** An endless body that counts how many chunks were pulled. */
  function endlessBody(chunkSize: number) {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(chunkSize).fill(0x61)); // 'a'
      },
    });
    return { body, pulled: () => pulled };
  }

  it('stops reading an unbounded body at the cap', async () => {
    const src = endlessBody(64 * 1024);
    const { text, truncated } = await readBodyCapped({ body: src.body }, 200 * 1024);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBe(200 * 1024);
    // 200 KiB / 64 KiB → 4 chunks pulled (plus at most one read-ahead), never unbounded.
    expect(src.pulled()).toBeLessThanOrEqual(5);
  });

  it('returns the whole body when under the cap', async () => {
    const body = new Response('hello world').body;
    await expect(readBodyCapped({ body }, 1024)).resolves.toEqual({ text: 'hello world', truncated: false });
  });

  it('handles a null body', async () => {
    await expect(readBodyCapped({ body: null }, 10)).resolves.toEqual({ text: '', truncated: false });
  });
});
