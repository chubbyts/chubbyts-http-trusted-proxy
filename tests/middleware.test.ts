import { describe, expect, test } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import { useObjectMock } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import { createServerRequestFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
import type { ForwardedHeaders, ForwardedResolver, TrustedProxyAttributes } from '../src/middleware.js';
import { DEFAULT_FORWARDED_HEADERS, createForwardedResolver, createTrustedProxyMiddleware } from '../src/middleware.js';

// the resolver gets exercised against @chubbyts/chubbyts-http as implementation, the middleware against mocked helpers
const serverRequestFactory = createServerRequestFactory();
const serverRequestHelpers = createServerRequestHelpers();

// the helpers get mocked: the attributes get set through them, the label makes each step a distinct request to
// prove the changes get chained
const createMockRequest = (label: string): ServerRequest => ({ method: label }) as ServerRequest;

const createResponse = (): Response => ({
  status: 200,
  reasonPhrase: 'OK',
  protocolVersion: '1.1',
  headers: {},
  body: (async function* () {})(),
});

const none = { clientIp: undefined, scheme: undefined, host: undefined };
const ip = (clientIp: string) => ({ ...none, clientIp });

const createRequest = (
  headers: Record<string, string | Array<string>> = {},
  attributes: Record<string, unknown> = {},
): ServerRequest =>
  Object.entries(attributes).reduce<ServerRequest>(
    (request, [name, value]) => serverRequestHelpers.withAttribute(request, name, value),
    Object.entries(headers).reduce(
      (request, [name, value]) => serverRequestHelpers.withHeader(request, name, value),
      serverRequestFactory('GET', 'https://api.example.com/resource'),
    ),
  );

// the header resolution gets tested without the address of the connection (the mode for servers not providing it),
// the anchoring at the address gets its own tests
const createHeadersOnlyResolver = (trustedProxies: Array<string>, headers?: ForwardedHeaders) =>
  createForwardedResolver(serverRequestHelpers, trustedProxies, headers, false);

describe('middleware', () => {
  describe('createForwardedResolver', () => {
    test('with invalid trusted proxies', () => {
      for (const subnet of [
        'not-an-ip',
        '10.0.0.0/33',
        'fd00::/129',
        '10.0.0.0/',
        '10.0.0.0/-1',
        '10.0.0.0/8x',
        '10.0.0.0/8/1',
      ]) {
        expect(() => createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8', subnet])).toThrow(
          `trustedProxies must contain valid ips or cidrs, ${subnet} given`,
        );
      }

      // a zone id would never match, as entries with one are never trusted
      for (const subnet of ['fe80::1%eth0', 'fe80::%eth0/64', '[::1]', '10.0.0.1:80']) {
        expect(() => createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8', subnet])).toThrow(
          `trustedProxies must contain valid ips or cidrs, ${subnet} given`,
        );
      }

      for (const [subnet, type] of [
        [42, 'number'],
        [null, 'null'],
        [{ trim: () => '10.0.0.0/8' }, 'object'],
        [['10.0.0.0/8'], 'object'],
      ]) {
        expect(() =>
          createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8', subnet] as unknown as Array<string>),
        ).toThrow(new TypeError(`trustedProxies must contain valid ips or cidrs, ${type} given`));
      }

      for (const subnet of ['0.0.0.0/0', '::/0', '::ffff:0:0/96', '::ffff:0.0.0.0/96']) {
        expect(() => createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8', subnet])).toThrow(
          `trustedProxies must not contain a subnet matching every ip, ${subnet} given`,
        );
      }

      expect(() => createForwardedResolver(serverRequestHelpers, '10.0.0.0/8' as unknown as Array<string>)).toThrow(
        new TypeError('trustedProxies must be an array of ips or cidrs, string given'),
      );

      expect(() => createForwardedResolver(serverRequestHelpers, null as unknown as Array<string>)).toThrow(
        new TypeError('trustedProxies must be an array of ips or cidrs, null given'),
      );

      expect(() => createForwardedResolver(serverRequestHelpers, [])).toThrow('trustedProxies must not be empty');
    });

    test('with invalid headers', () => {
      expect(() =>
        createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], 'x-real-ip' as unknown as ForwardedHeaders),
      ).toThrow(new TypeError('headers must be an object with the keys for, proto and host, string given'));
      expect(() =>
        createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], null as unknown as ForwardedHeaders),
      ).toThrow(new TypeError('headers must be an object with the keys for, proto and host, null given'));
      expect(() =>
        createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], ['x-real-ip'] as unknown as ForwardedHeaders),
      ).toThrow(new TypeError('headers must be an object with the keys for, proto and host, object given'));
      expect(() =>
        createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], {
          for: 'x-real-ip',
          port: 'x-port',
        } as unknown as ForwardedHeaders),
      ).toThrow(new TypeError('headers must be an object with the keys for, proto and host, key port given'));
      expect(() =>
        createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], { for: null as unknown as string }),
      ).toThrow(new TypeError('headers.for must be a string, null given'));
      expect(() =>
        createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], { for: 1 as unknown as string }),
      ).toThrow(new TypeError('headers.for must be a string, number given'));
      expect(() =>
        createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], { proto: 1 as unknown as string }),
      ).toThrow(new TypeError('headers.proto must be a string or null, number given'));
      expect(() => createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], { for: 'bad header name' })).toThrow(
        'headers.for must be a valid header name, bad header name given',
      );
      expect(() => createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], { host: '' })).toThrow(
        'headers.host must be a valid header name,  given',
      );
    });

    test('with invalid requireRemoteAddress', () => {
      expect(() =>
        createForwardedResolver(
          serverRequestHelpers,
          ['10.0.0.0/8'],
          DEFAULT_FORWARDED_HEADERS,
          'yes' as unknown as boolean,
        ),
      ).toThrow(new TypeError('requireRemoteAddress must be a boolean, string given'));
      expect(() =>
        createForwardedResolver(
          serverRequestHelpers,
          ['10.0.0.0/8'],
          DEFAULT_FORWARDED_HEADERS,
          null as unknown as boolean,
        ),
      ).toThrow(new TypeError('requireRemoteAddress must be a boolean, null given'));
    });

    test('with default headers, frozen', () => {
      expect(Object.isFrozen(DEFAULT_FORWARDED_HEADERS)).toBe(true);
    });

    test('with partial headers, the given ones replace their defaults', () => {
      const request = createRequest({
        'x-forwarded-for': 'spoofed',
        'x-real-ip': '203.0.113.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.com',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { for: 'x-real-ip' })(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { for: 'x-real-ip', proto: undefined })(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
      expect(createHeadersOnlyResolver(['10.0.0.0/8'], {})(request)).toStrictEqual(none);
      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { for: undefined })(request)).toStrictEqual(none);
      // inherited keys get ignored
      expect(
        createHeadersOnlyResolver(['10.0.0.0/8'], Object.create({ for: 'x-real-ip' }) as ForwardedHeaders)(request),
      ).toStrictEqual(none);
    });

    test('with null headers, proto and host get disabled', () => {
      const request = createRequest({
        'x-forwarded-for': '203.0.113.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.com',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { proto: null })(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: undefined,
        host: 'example.com',
      });
      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { proto: null, host: null })(request)).toStrictEqual(
        ip('203.0.113.1'),
      );
    });

    test('with untrimmed trusted proxies', () => {
      expect(
        createHeadersOnlyResolver([' 10.0.0.0/8 ', '::1\n'])(
          createRequest({ 'x-forwarded-for': '203.0.113.1, ::1, 10.0.0.1' }),
        ),
      ).toStrictEqual(ip('203.0.113.1'));
    });

    test('without headers', () => {
      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(createRequest())).toStrictEqual(none);
    });

    test('without for header, the other headers get ignored', () => {
      expect(
        createHeadersOnlyResolver(['10.0.0.0/8'])(
          createRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' }),
        ),
      ).toStrictEqual(none);
    });

    test('with empty or blank for entries', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      expect(resolve(createRequest({ 'x-forwarded-for': '' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': ',,' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1, ' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': ' , 10.0.0.1' }))).toStrictEqual(none);
    });

    test('with ips and cidrs, the first untrusted entry from the right', () => {
      const resolve = createHeadersOnlyResolver([
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.1.1',
        'fd00::/8',
        '2001:db8:1:2::/64',
        '::1',
      ]);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('spoofed, 203.0.113.1 , 10.255.255.255, ::1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 172.31.255.255, fd12::1, 192.168.1.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 198.51.100.1')).toStrictEqual(ip('198.51.100.1'));
      expect(clientIpOf('203.0.113.1, 11.0.0.0')).toStrictEqual(ip('11.0.0.0'));
      expect(clientIpOf('203.0.113.1, 9.255.255.255')).toStrictEqual(ip('9.255.255.255'));
      expect(clientIpOf('203.0.113.1, 172.32.0.0')).toStrictEqual(ip('172.32.0.0'));
      expect(clientIpOf('203.0.113.1, 192.168.1.2')).toStrictEqual(ip('192.168.1.2'));
      expect(clientIpOf('203.0.113.1, fe80::1')).toStrictEqual(ip('fe80::1'));
      expect(clientIpOf('203.0.113.1, fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toStrictEqual(
        ip('fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'),
      );
      expect(clientIpOf('203.0.113.1, 2001:db8:1:2:ffff:ffff:ffff:ffff')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 2001:db8:1:3::')).toStrictEqual(ip('2001:db8:1:3::'));
      expect(clientIpOf('203.0.113.1, ::2')).toStrictEqual(ip('::2'));
      // an ipv4 does not match an ipv6 subnet with the same leading bytes
      expect(clientIpOf('203.0.113.1, 253.0.0.1')).toStrictEqual(ip('253.0.0.1'));
      expect(clientIpOf('203.0.113.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('10.0.0.1')).toStrictEqual(none);
      expect(clientIpOf('10.0.0.1, 10.0.0.2')).toStrictEqual(none);
    });

    test('with ipv4 mapped ipv6 addresses, matching ipv4 subnets and resolving as ipv4', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('203.0.113.1, ::ffff:10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, ::FFFF:10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, ::ffff:a00:1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, ::ffff:11.0.0.1')).toStrictEqual(ip('11.0.0.1'));
      expect(clientIpOf('::ffff:203.0.113.1, 10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('::FFFF:203.0.113.1, 10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('::ffff:cb00:7101, 10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
    });

    test('with ipv4 mapped ipv6 subnets, matching as ipv4 subnets', () => {
      const resolve = createHeadersOnlyResolver(['::ffff:10.0.0.0/104', '::ffff:192.168.1.1']);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('203.0.113.1, 10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, ::ffff:10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 192.168.1.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 11.0.0.1')).toStrictEqual(ip('11.0.0.1'));
      expect(clientIpOf('203.0.113.1, 192.168.1.2')).toStrictEqual(ip('192.168.1.2'));
    });

    test('with ipv6 subnets covering the ipv4 mapped addresses, no ipv4 trusted', () => {
      for (const subnet of ['::/8', '::/64', '::ffff:0:0/95', '::ffff:10.0.0.1/64']) {
        const resolve = createHeadersOnlyResolver([subnet]);

        const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

        expect(clientIpOf('2001:db8::5, 203.0.113.5')).toStrictEqual(ip('203.0.113.5'));
        expect(clientIpOf('2001:db8::5, ::ffff:203.0.113.5')).toStrictEqual(ip('203.0.113.5'));
      }

      // the ipv6 entries still match
      expect(
        createHeadersOnlyResolver(['::/8'])(createRequest({ 'x-forwarded-for': '203.0.113.5, ::1' })),
      ).toStrictEqual(ip('203.0.113.5'));
    });

    test('with non canonical ips, the canonical form', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('2001:DB8:0000:0:0::0001')).toStrictEqual(ip('2001:db8::1'));
      expect(clientIpOf('2001:0db8:0000:0000:0000:0000:0000:0001, 10.0.0.1')).toStrictEqual(ip('2001:db8::1'));
      expect(clientIpOf('0:0::1')).toStrictEqual(ip('::1'));
    });

    test('with zone ids, not a valid ip and never trusted', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8', 'fd00::/8']);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('fe80::1%eth0')).toStrictEqual(none);
      expect(clientIpOf('fe80::1%eth0, 10.0.0.1')).toStrictEqual(none);
      expect(clientIpOf('203.0.113.1, fd00::1%eth0')).toStrictEqual(none);
      expect(clientIpOf('203.0.113.1, ::ffff:10.0.0.1%eth0')).toStrictEqual(none);
    });

    test('with non ip entries, never trusted and never a client ip', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1, unknown, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1:54321, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '[2001:db8::1]:443, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': 'junk, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': 'unknown, 203.0.113.1, 10.0.0.1' }))).toStrictEqual(
        ip('203.0.113.1'),
      );
    });

    test('with non ip client entry, the other headers get ignored', () => {
      const request = createRequest({
        'x-forwarded-for': 'unknown, 10.0.0.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.com',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(request)).toStrictEqual(none);
    });

    test('with all headers, aligned entries', () => {
      const request = createRequest({
        'x-forwarded-for': 'spoofed, 203.0.113.1, 10.0.0.1',
        'x-forwarded-proto': 'spoofed, HTTPS, http',
        'x-forwarded-host': 'spoofed, Example.com, internal',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
    });

    test('with all headers, client supplied for entries, aligned from the right', () => {
      const resolve = createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8']);

      // two proxies appending to all the headers, the client sent x-forwarded-for entries of its own
      for (const forwardedFor of [
        '203.0.113.1, 10.0.0.1',
        '9.9.9.9, 203.0.113.1, 10.0.0.1',
        'a, b, 203.0.113.1, 10.0.0.1',
      ]) {
        expect(
          resolve(
            createRequest(
              {
                'x-forwarded-for': forwardedFor,
                'x-forwarded-proto': 'https, http',
                'x-forwarded-host': 'public.example.com, internal.svc.local',
              },
              { remoteAddress: '10.0.0.2' },
            ),
          ),
        ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'https', host: 'public.example.com' });
      }
    });

    test('with all headers, fewer entries than hops, the last entry', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      expect(
        resolve(
          createRequest({
            'x-forwarded-for': 'spoofed, 203.0.113.1, 10.0.0.1',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'example.com',
          }),
        ),
      ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'https', host: 'example.com' });

      expect(
        resolve(
          createRequest({
            'x-forwarded-for': '203.0.113.1',
            'x-forwarded-proto': 'http, https',
            'x-forwarded-host': 'spoofed, example.com',
          }),
        ),
      ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'https', host: 'example.com' });
    });

    test('with blank proto and host entries', () => {
      const request = createRequest({
        'x-forwarded-for': '203.0.113.1',
        'x-forwarded-proto': '',
        'x-forwarded-host': ' ',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(request)).toStrictEqual(ip('203.0.113.1'));
    });

    test('with invalid proto and host entries, nothing but the client ip', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      const cases: Array<[string, string]> = [
        ['javascript', 'example com'],
        ['ht\ttps', 'example.com/path'],
        ['https;', 'https://example.com'],
        ['http-', 'user@example.com'],
        ['data', 'exämple.com'],
        ['ws', 'example..com'],
        ['wss', '-example.com'],
        ['ht tps', '2001:db8::1'],
        ['https:', '[junk]'],
        ['http/1.1', 'example.com:123456'],
        ['https://', 'example.com:65536'],
        ['h ttp', '[203.0.113.1]'],
        ['HTTPS;', '[2001:db8::1::2]'],
        ['https.', 'example.com:0'],
        ['httpss', '[fe80::1%eth0]'],
        ['javascript:', '2130706433'],
        ['vbscript', '127.1'],
        ['file', '0x7f.0.0.1'],
        ['ftp', '0177.0.0.1'],
        ['gopher', '999.999.999.999'],
        ['mailto', '1.2.3.4.5'],
        ['tel', 'example.123'],
        ['callto', 'example.0x'],
        ['sms', `${'a'.repeat(64)}.example.com`],
        ['urn', `${'a.'.repeat(126)}ab`],
        ['about', 'example.com..'],
        ['http:', 'x[2001:db8::1]'],
        ['https-', '[2001:db8::1]x'],
      ];

      for (const [proto, host] of cases) {
        expect(
          resolve(
            createRequest({ 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': proto, 'x-forwarded-host': host }),
          ),
        ).toStrictEqual(ip('203.0.113.1'));
      }
    });

    test('with valid host entries, the lowercased host', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      const cases: Array<[string, string]> = [
        ['example.com', 'example.com'],
        ['example.com:8443', 'example.com:8443'],
        ['localhost', 'localhost'],
        ['a.example.com', 'a.example.com'],
        ['www.example.com', 'www.example.com'],
        ['example.com.', 'example.com'],
        ['Example.Com.:8443', 'example.com:8443'],
        ['example.com:0080', 'example.com:80'],
        ['0x7f.example.com', '0x7f.example.com'],
        ['123.example.com', '123.example.com'],
        ['example.0xg', 'example.0xg'],
        ['example.a1', 'example.a1'],
        [`${'a'.repeat(63)}.example.com`, `${'a'.repeat(63)}.example.com`],
        [`${'a.'.repeat(126)}a`, `${'a.'.repeat(126)}a`],
        [`${'a.'.repeat(126)}a.`, `${'a.'.repeat(126)}a`],
        ['[2001:0DB8:0000::0001]:00443', '[2001:db8::1]:443'],
        ['[::FFFF:CB00:7101]', '[::ffff:203.0.113.1]'],
        ['xn--exmple-cua.com', 'xn--exmple-cua.com'],
        ['my-example.com', 'my-example.com'],
        ['203.0.113.1', '203.0.113.1'],
        ['203.0.113.1:8080', '203.0.113.1:8080'],
        ['[2001:db8::1]', '[2001:db8::1]'],
        ['[2001:db8::1]:8080', '[2001:db8::1]:8080'],
        ['[::ffff:203.0.113.1]', '[::ffff:203.0.113.1]'],
        ['example.com:65535', 'example.com:65535'],
        ['example.com:1', 'example.com:1'],
        ['EXAMPLE.COM', 'example.com'],
        ['Example.Com:8443', 'example.com:8443'],
        ['[2001:DB8::1]', '[2001:db8::1]'],
      ];

      for (const [host, expectedHost] of cases) {
        expect(
          resolve(
            createRequest({ 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'HTTP', 'x-forwarded-host': host }),
          ),
        ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'http', host: expectedHost });
      }
    });

    test('with trusted remoteAddress, the headers get used', () => {
      const resolve = createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8', '::1']);

      const headers = { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' };

      for (const remoteAddress of [
        '10.0.0.1',
        '10.0.0.1:54321',
        '10.0.0.1:1',
        '10.0.0.1:65535',
        '::ffff:10.0.0.1',
        '[::1]:54321',
      ]) {
        expect(resolve(createRequest(headers, { remoteAddress }))).toStrictEqual({
          clientIp: '203.0.113.1',
          scheme: 'https',
          host: undefined,
        });
      }
    });

    test('with untrusted remoteAddress, the headers get ignored', () => {
      const resolve = createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8']);

      const headers = { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' };

      const cases: Array<[string, string | undefined]> = [
        ['198.51.100.1', '198.51.100.1'],
        ['198.51.100.1:54321', '198.51.100.1'],
        ['2001:DB8::1', '2001:db8::1'],
        ['[2001:db8::1]:54321', '2001:db8::1'],
        ['::FFFF:198.51.100.1', '198.51.100.1'],
        ['[::ffff:198.51.100.1]:54321', '198.51.100.1'],
        ['', undefined],
        ['not-an-ip', undefined],
        ['198.51.100.1:54321junk', undefined],
        ['x[::1]:54321', undefined],
        ['[::1]:54321junk', undefined],
        ['fe80::1%eth0', undefined],
        ['10.0.0.1:port', undefined],
        ['10.0.0.1:', undefined],
        ['10.0.0.1:0', undefined],
        ['10.0.0.1:65536', undefined],
        ['10.0.0.1:654321', undefined],
        ['[::1]:0', undefined],
        ['[::1]', undefined],
        ['[::1]:', undefined],
        ['[::1:54321', undefined],
      ];

      for (const [remoteAddress, clientIp] of cases) {
        expect(resolve(createRequest(headers, { remoteAddress }))).toStrictEqual({ ...none, clientIp });
      }
    });

    test('with non string remoteAddress, nothing gets resolved', () => {
      const resolve = createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8']);

      for (const remoteAddress of [1, true, null, ['10.0.0.1'], { address: '10.0.0.1' }]) {
        expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1' }, { remoteAddress }))).toStrictEqual(none);
      }
    });

    test('without remoteAddress, nothing gets resolved', () => {
      const resolve = createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8']);

      const headers = { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' };

      expect(resolve(createRequest(headers))).toStrictEqual(none);
      expect(resolve(createRequest(headers, { remoteAddress: undefined }))).toStrictEqual(none);
    });

    test('without remoteAddress, not required, the headers get used', () => {
      const resolve = createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], DEFAULT_FORWARDED_HEADERS, false);

      const headers = { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' };

      expect(resolve(createRequest(headers))).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: undefined,
      });
      expect(resolve(createRequest(headers, { remoteAddress: undefined }))).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: undefined,
      });
      // a given address still anchors the trust
      expect(resolve(createRequest(headers, { remoteAddress: '198.51.100.1' }))).toStrictEqual(ip('198.51.100.1'));
      expect(resolve(createRequest(headers, { remoteAddress: 'not-an-ip' }))).toStrictEqual(none);
    });

    test('with multiple header lines, the entries of all of them', () => {
      const request = createRequest({
        'x-forwarded-for': ['spoofed', '203.0.113.1, 10.0.0.1'],
        'x-forwarded-proto': ['http', 'https, http'],
        'x-forwarded-host': ['spoofed', 'example.com', 'internal'],
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
    });

    test('with custom headers', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8'], { for: 'x-real-ip', proto: 'x-scheme', host: null });

      expect(
        resolve(
          createRequest({
            'x-forwarded-for': 'spoofed',
            'x-real-ip': '203.0.113.1',
            'x-scheme': 'https',
            'x-forwarded-host': 'spoofed',
          }),
        ),
      ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'https', host: undefined });
    });
  });

  describe('createTrustedProxyMiddleware', () => {
    test.each<[string, TrustedProxyAttributes]>([
      ['without resolved values, the attributes get reset', none],
      ['with resolved values', { clientIp: '203.0.113.1', scheme: 'https', host: 'example.com' }],
      ['with partially resolved values', ip('203.0.113.1')],
    ])('%s', async (_, resolved) => {
      const request = createMockRequest('given');
      const requestWithClientIp = createMockRequest('client-ip');
      const requestWithScheme = createMockRequest('scheme');
      const requestWithHost = createMockRequest('host');
      const response = createResponse();

      const [forwardedResolver, forwardedResolverMocks] = useFunctionMock<ForwardedResolver>([
        { parameters: [request], return: resolved },
      ]);

      const [mockedServerRequestHelpers, mockedServerRequestHelpersMocks] = useObjectMock<ServerRequestHelpers>([
        { name: 'withAttribute', parameters: [request, 'clientIp', resolved.clientIp], return: requestWithClientIp },
        {
          name: 'withAttribute',
          parameters: [requestWithClientIp, 'scheme', resolved.scheme],
          return: requestWithScheme,
        },
        { name: 'withAttribute', parameters: [requestWithScheme, 'host', resolved.host], return: requestWithHost },
      ]);

      const [handler, handlerMocks] = useFunctionMock<Handler<TrustedProxyAttributes>>([
        { parameters: [requestWithHost as ServerRequest<TrustedProxyAttributes>], return: Promise.resolve(response) },
      ]);

      expect(await createTrustedProxyMiddleware(mockedServerRequestHelpers, forwardedResolver)(request, handler)).toBe(
        response,
      );

      expect(forwardedResolverMocks).toHaveLength(0);
      expect(mockedServerRequestHelpersMocks).toHaveLength(0);
      expect(handlerMocks).toHaveLength(0);
    });

    test('with chubbyts-http, existing attributes get overwritten, others kept', async () => {
      const request = createRequest({}, { clientIp: 'spoofed', scheme: 'spoofed', host: 'spoofed', other: 'kept' });
      const response = createResponse();

      const [forwardedResolver, forwardedResolverMocks] = useFunctionMock<ForwardedResolver>([
        { parameters: [request], return: ip('203.0.113.1') },
      ]);

      const [handler, handlerMocks] = useFunctionMock<Handler<TrustedProxyAttributes>>([
        {
          callback: async (givenRequest): Promise<Response> => {
            expect(givenRequest).not.toBe(request);
            expect(givenRequest.uri).toBe(request.uri);
            expect(givenRequest.attributes).toStrictEqual({
              clientIp: '203.0.113.1',
              scheme: undefined,
              host: undefined,
              other: 'kept',
            });

            return response;
          },
        },
      ]);

      expect(await createTrustedProxyMiddleware(serverRequestHelpers, forwardedResolver)(request, handler)).toBe(
        response,
      );

      expect(forwardedResolverMocks).toHaveLength(0);
      expect(handlerMocks).toHaveLength(0);
    });
  });
});
