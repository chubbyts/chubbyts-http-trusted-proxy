import { BlockList, SocketAddress, isIP, isIPv4, isIPv6 } from 'node:net';
import type { Attributes, Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { MessageHelpers, ServerRequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';

/**
 * The (case insensitive) names of the headers the proxies forward the client data within, `for` is the base for the
 * trust decision, the others get only resolved when a client ip was resolved. Each one is optional and replaces its
 * default (`x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`), `null` disables `proto` and `host`, `for`
 * cannot be disabled.
 */
export type ForwardedHeaders = {
  /** the client ip, e.g. `x-forwarded-for` or `x-real-ip` */
  for?: string;
  /** the scheme the client used, e.g. `x-forwarded-proto`, `null` disables it */
  proto?: string | null;
  /** the host the client requested, e.g. `x-forwarded-host`, `null` disables it */
  host?: string | null;
};

// frozen, as the resolvers fall back to it: a change would silently affect every resolver created afterwards
export const DEFAULT_FORWARDED_HEADERS: Readonly<{ for: string; proto: string; host: string }> = Object.freeze({
  for: 'x-forwarded-for',
  proto: 'x-forwarded-proto',
  host: 'x-forwarded-host',
});

/**
 * The request attributes the middleware sets, the unresolved ones as `undefined`.
 */
export type TrustedProxyAttributes = {
  readonly clientIp: string | undefined;
  readonly scheme: 'http' | 'https' | undefined;
  readonly host: string | undefined;
};

/**
 * Resolves the client data of a request out of the forwarded headers, every value not resolvable is `undefined`
 * (always all keys, so that the middleware overwrites whatever was set before it).
 */
export type ForwardedResolver = (request: ServerRequest) => TrustedProxyAttributes;

type ResolvedForwardedHeaders = { for: string; proto: string | null; host: string | null };

const HEADER_KEYS = new Set(['for', 'proto', 'host']);

const SCHEMES: ReadonlySet<string> = new Set(['http', 'https']);

// a header name has to be a token (RFC 9110 5.1)
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// hostname or ipv4: labels of letters, digits and hyphens (not at the edges), optionally fully qualified
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/;

// the max length of a hostname (without the trailing dot) and of each of its labels (rfc 1035 2.3.4)
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

// a hostname ending with a numeric (decimal or hex) label is an ipv4 for url parsers (whatwg url "ends in a number"),
// which then must be a valid dotted one (`127.1`, `2130706433`, `0x7f.0.0.1`, `999.999.999.999` are not)
const NUMERIC_LABEL_PATTERN = /^(?:\d+|0x[0-9a-f]*)$/i;

// the ipv6 within the brackets gets validated afterwards
const BRACKETED_IPV6_PATTERN = /^\[([0-9A-Fa-f:.]+)\]$/;

// the port suffix of a host, the port gets validated afterwards
const PORT_PATTERN = /:(\d{1,5})$/;

const MIN_PORT = 1;
const MAX_PORT = 65535;

// the canonical form of an ipv4 mapped ipv6 address (`::ffff:203.0.113.1`), which resolves as the ipv4
// Stryker disable next-line Regex: equivalent mutants, the canonical form contains the dotted ipv4 at the end only
const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

// the prefix of the ipv4 mapped ipv6 addresses (`::ffff:0:0/96`)
const IPV4_MAPPED_PREFIX = 96;

const NONE: TrustedProxyAttributes = { clientIp: undefined, scheme: undefined, host: undefined };

type Family = 'ipv4' | 'ipv6';

const typeOf = (value: unknown): string => (value === null ? 'null' : typeof value);

const familyOf = (ip: string): Family => (isIPv4(ip) ? 'ipv4' : 'ipv6');

// only a valid ip is a client ip, everything else (blank, "unknown", ip:port, zone id, junk) resolves nothing, in its
// canonical form (lowercased, compressed, ipv4 mapped ipv6 addresses as ipv4) so that the same client always
// resolves to the same string
const asIp = (entry: string): string | undefined => {
  // a zone id (`fe80::1%eth0`) is not a valid ip, even though node accepts (and strips) it
  if (!isIP(entry) || entry.includes('%')) {
    return undefined;
  }

  const ip = new SocketAddress({ address: entry, family: isIPv6(entry) ? 'ipv6' : 'ipv4' }).address;

  return IPV4_MAPPED_PATTERN.exec(ip)?.[1] ?? ip;
};

// an ipv4 mapped ipv6 subnet (`::ffff:10.0.0.0/104`) becomes its ipv4 subnet (`10.0.0.0/8`), as the entries get
// canonicalized the same way, every other subnet is matched against the entries of its own family only, so that an
// ipv6 subnet covering the mapped addresses (`::/8`) cannot trust every ipv4
const parseSubnet = (subnet: unknown): { address: string; prefix: number; family: Family } => {
  if (typeof subnet !== 'string') {
    throw new TypeError(`trustedProxies must contain valid ips or cidrs, ${typeOf(subnet)} given`);
  }

  // trimmed, as config often comes out of env vars
  const [address, prefix, ...rest] = subnet.trim().split('/');

  const ip = asIp(address);

  if (rest.length > 0 || ip === undefined || (prefix !== undefined && !/^\d+$/.test(prefix))) {
    throw new Error(`trustedProxies must contain valid ips or cidrs, ${subnet} given`);
  }

  const maxPrefix = isIPv4(address) ? 32 : 128;
  const parsedPrefix = prefix === undefined ? maxPrefix : Number(prefix);

  if (parsedPrefix > maxPrefix) {
    throw new Error(`trustedProxies must contain valid ips or cidrs, ${subnet} given`);
  }

  // an ipv6 canonicalized as ipv4 (the prefix of an ipv4 subnet is never that long)
  const mapped = isIPv4(ip) && parsedPrefix >= IPV4_MAPPED_PREFIX;

  const resolved = mapped
    ? { address: ip, prefix: parsedPrefix - IPV4_MAPPED_PREFIX, family: 'ipv4' as const }
    : { address, prefix: parsedPrefix, family: familyOf(address) };

  if (resolved.prefix === 0) {
    throw new Error(`trustedProxies must not contain a subnet matching every ip, ${subnet} given`);
  }

  return resolved;
};

// fail fast at creation instead of per request within the injected helpers, which may or may not validate the name
const validHeaderName = (key: keyof ForwardedHeaders, name: unknown): string => {
  if (typeof name !== 'string') {
    throw new TypeError(`headers.${key} must be a string${key === 'for' ? '' : ' or null'}, ${typeOf(name)} given`);
  }

  if (!HEADER_NAME_PATTERN.test(name)) {
    throw new Error(`headers.${key} must be a valid header name, ${name} given`);
  }

  return name;
};

// a given (not undefined) name replaces the default, `null` disables the header
const resolveOptionalHeaderName = (key: 'proto' | 'host', name: string | null | undefined): string | null => {
  if (name === undefined) {
    return DEFAULT_FORWARDED_HEADERS[key];
  }

  return name === null ? null : validHeaderName(key, name);
};

// `for` cannot be disabled (without it the resolver would silently resolve nothing), an unknown key (a typo) throws
const resolveHeaderNames = (headers: ForwardedHeaders): ResolvedForwardedHeaders => {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new TypeError(`headers must be an object with the keys for, proto and host, ${typeOf(headers)} given`);
  }

  for (const key of Object.keys(headers)) {
    if (!HEADER_KEYS.has(key)) {
      throw new TypeError(`headers must be an object with the keys for, proto and host, key ${key} given`);
    }
  }

  // own keys only, the destructuring default applies to undefined only, null must fail the validation
  const { for: forName = DEFAULT_FORWARDED_HEADERS.for, proto, host } = { ...headers };

  return {
    for: validHeaderName('for', forName),
    proto: resolveOptionalHeaderName('proto', proto),
    host: resolveOptionalHeaderName('host', host),
  };
};

const asScheme = (entry: string | undefined): TrustedProxyAttributes['scheme'] => {
  if (entry === undefined) {
    return undefined;
  }

  const scheme = entry.toLowerCase();

  return SCHEMES.has(scheme) ? (scheme as TrustedProxyAttributes['scheme']) : undefined;
};

// in its canonical form, so that the same host always resolves to the same string: lowercased (hosts are case
// insensitive, rfc 3986), without the trailing dot of a fully qualified hostname, an ipv6 compressed
const asHostname = (host: string): string | undefined => {
  const ipv6 = BRACKETED_IPV6_PATTERN.exec(host)?.[1];

  if (ipv6 !== undefined) {
    return isIPv6(ipv6) ? `[${new SocketAddress({ address: ipv6, family: 'ipv6' }).address}]` : undefined;
  }

  if (!HOSTNAME_PATTERN.test(host)) {
    return undefined;
  }

  const hostname = (host.endsWith('.') ? host.slice(0, -1) : host).toLowerCase();
  const labels = hostname.split('.');

  if (
    hostname.length > MAX_HOSTNAME_LENGTH ||
    labels.some((label) => label.length > MAX_LABEL_LENGTH) ||
    (NUMERIC_LABEL_PATTERN.test(labels.at(-1) as string) && !isIPv4(hostname))
  ) {
    return undefined;
  }

  return hostname;
};

const asHost = (entry: string | undefined): string | undefined => {
  if (entry === undefined) {
    return undefined;
  }

  const portMatch = PORT_PATTERN.exec(entry);

  if (portMatch !== null && (Number(portMatch[1]) < MIN_PORT || Number(portMatch[1]) > MAX_PORT)) {
    return undefined;
  }

  const hostname = asHostname(portMatch === null ? entry : entry.slice(0, portMatch.index));

  if (hostname === undefined) {
    return undefined;
  }

  // the port without leading zeros (`0080` as `80`), a default port stays, as it depends on the scheme
  return portMatch === null ? hostname : `${hostname}:${Number(portMatch[1])}`;
};

// strips the port some servers provide the address with (`10.0.0.1:54321`, `[::1]:54321`), everything else (an
// invalid port as well, which then resolves nothing) stays as it is
const withoutPort = (address: string): string => {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(address);

  if (match === null || Number(match[3]) < MIN_PORT || Number(match[3]) > MAX_PORT) {
    return address;
  }

  return match[1] ?? match[2];
};

// the address of the connection, without a port, so that it can be matched against the trusted proxies. Undefined if
// there is none (e.g. a unix socket), a broken (non string) one counts as set: it is returned as an empty string,
// which is never a trusted proxy nor a valid ip, so that it resolves nothing instead of falling back to the headers
const remoteAddressOf = (request: ServerRequest): string | undefined => {
  const { remoteAddress } = request.attributes;

  if (remoteAddress === undefined) {
    return undefined;
  }

  // Stryker disable next-line StringLiteral: equivalent mutant, any non ip string resolves nothing as well
  return typeof remoteAddress === 'string' ? withoutPort(remoteAddress) : '';
};

/**
 * Creates a resolver for the client ip, scheme and host of a request out of the forwarded `headers`, read through the
 * injected `messageHelpers`:
 *  - the address of the connection (the `remoteAddress` attribute, as set by the server or a middleware in front, a
 *    port gets stripped) anchors the trust: a connection from outside the `trustedProxies` ips / cidrs (e.g.
 *    `['10.0.0.0/8', '::1']`, ipv4 mapped ipv6 addresses match ipv4 subnets, ipv4 mapped ipv6 subnets are ipv4
 *    subnets, zone ids and non strings throw) is the client itself, its address is
 *    the client ip and the headers get ignored. An address which is not a valid ip (junk, a non string) resolves
 *    nothing, never a fallback to the headers, as they cannot be trusted without knowing the connection either.
 *    Without any address (`undefined`), nothing gets resolved (fail closed), unless `requireRemoteAddress` is
 *    `false`, in which case the last hop counts as trusted (the server must then not be reachable except through the
 *    proxies).
 *  - the entries of the `for` header get walked from the right (the entries as appended by the proxies, the nearest
 *    one last), skipping the trusted ones, the first untrusted one is the client ip, if it is a valid ip. Only
 *    trusted entries, or an untrusted one which is not a valid ip (blank, `unknown`, `ip:port`, a zone id, junk),
 *    resolve nothing.
 *  - the client ip gets canonicalized (`2001:DB8:0:0::1` as `2001:db8::1`, `::ffff:203.0.113.1` as `203.0.113.1`),
 *    so that the same client always resolves to the same string.
 *  - the scheme and host get only resolved when a client ip was resolved: the entry of the proxy which appended the
 *    client ip, counted from the right (proxies appending to all the headers), if the header has as many entries as
 *    hops, the last (the one the nearest proxy set) otherwise. The scheme gets lowercased and must be `http` or
 *    `https`, the host must be a syntactically valid host (with an optional port from 1 to 65535) and gets
 *    canonicalized (lowercased, without trailing dot, an ipv6 compressed, the port without leading zeros), everything
 *    else resolves `undefined`.
 */
export const createForwardedResolver = (
  messageHelpers: MessageHelpers,
  trustedProxies: Array<string>,
  headers: ForwardedHeaders = DEFAULT_FORWARDED_HEADERS,
  requireRemoteAddress = true,
): ForwardedResolver => {
  if (!Array.isArray(trustedProxies)) {
    throw new TypeError(`trustedProxies must be an array of ips or cidrs, ${typeOf(trustedProxies)} given`);
  }

  // an empty list trusts no entry, so the last one (set by the nearest proxy) would resolve as the client ip: reject
  // it, as the middleware makes no sense without a trusted proxy
  if (trustedProxies.length === 0) {
    throw new Error('trustedProxies must not be empty');
  }

  const resolvedHeaders = resolveHeaderNames(headers);

  if (typeof requireRemoteAddress !== 'boolean') {
    throw new TypeError(`requireRemoteAddress must be a boolean, ${typeOf(requireRemoteAddress)} given`);
  }

  // one list per family: node matches an ipv4 against the ipv4 mapped range of ipv6 subnets as well
  const blockLists: Record<Family, BlockList> = { ipv4: new BlockList(), ipv6: new BlockList() };

  for (const { address, prefix, family } of trustedProxies.map(parseSubnet)) {
    blockLists[family].addSubnet(address, prefix, family);
  }

  // non ip entries are never trusted, the resolver rejects them as client ip afterwards
  const isTrustedProxy = (entry: string): boolean => {
    const ip = asIp(entry);

    if (ip === undefined) {
      return false;
    }

    const family = familyOf(ip);

    return blockLists[family].check(ip, family);
  };

  // a header can occur multiple times, each value can contain multiple comma separated entries
  const entriesOf = (request: ServerRequest, name: string | null): Array<string> => {
    if (name === null) {
      // Stryker disable next-line ArrayDeclaration: equivalent mutant, a junk entry is never an ip, scheme or host
      return [];
    }

    return messageHelpers
      .getHeader(request, name)
      .flatMap((value) => value.split(','))
      .map((entry) => entry.trim());
  };

  return (request: ServerRequest) => {
    const remoteAddress = remoteAddressOf(request);

    // set but not a trusted proxy: the client connected directly (its address is the client ip), or a broken address
    // which resolves nothing, either way the headers get ignored
    if (remoteAddress !== undefined && !isTrustedProxy(remoteAddress)) {
      return { ...NONE, clientIp: asIp(remoteAddress) };
    }

    if (remoteAddress === undefined && requireRemoteAddress) {
      return { ...NONE };
    }

    const forEntries = entriesOf(request, resolvedHeaders.for);
    const index = forEntries.findLastIndex((entry) => !isTrustedProxy(entry));
    // Stryker disable next-line StringLiteral: equivalent mutant, no replacement for a missing entry (index -1) is an ip
    const clientIp = asIp(forEntries[index] ?? '');

    if (clientIp === undefined) {
      return { ...NONE };
    }

    // the hops from the proxy which appended the client ip to the server
    const hops = forEntries.length - index;

    // aligned from the right, as the proxies append: entries the client sent along within the `for` header (a proxy
    // of its own, a spoofing attempt) do not shift it. Aligning only proves that the proxies append to this header as
    // well as to `for`, not that the entry is trustworthy: a proxy passing this header through untouched lets the
    // client choose it, which is why the proxies must set (or strip) all the forwarded headers (see
    // createTrustedProxyMiddleware). With fewer entries than hops, the last (the one the nearest proxy set).
    const alignedEntry = (entries: Array<string>): string | undefined => entries.at(-hops) ?? entries.at(-1);

    return {
      clientIp,
      scheme: asScheme(alignedEntry(entriesOf(request, resolvedHeaders.proto))),
      host: asHost(alignedEntry(entriesOf(request, resolvedHeaders.host))),
    };
  };
};

/**
 * Passes the request on with the values of the `forwardedResolver` as `clientIp`, `scheme` and `host` attributes
 * (the unresolved ones as `undefined`, so that nothing set before the middleware survives, no matter if resolved or
 * not), set through the injected `serverRequestHelpers`.
 *
 * Mind that the middleware only sees the headers and the `remoteAddress` attribute (if the server provides it), so
 * the proxies must set (or strip) all the forwarded headers, as any header they do not touch is supplied by the
 * client. The reset relies on `withAttribute` storing an `undefined` value (as @chubbyts/chubbyts-http does), an
 * implementation removing the attribute instead works as well, one ignoring the call would keep the value set before.
 */
export const createTrustedProxyMiddleware = (
  serverRequestHelpers: ServerRequestHelpers,
  forwardedResolver: ForwardedResolver,
): Middleware<Attributes, TrustedProxyAttributes> => {
  // changed through the injected implementation only: the middleware works with any of them
  return async (request: ServerRequest, handler: Handler<TrustedProxyAttributes>): Promise<Response> => {
    const { clientIp, scheme, host } = forwardedResolver(request);

    // typed without the other attributes (they get kept anyway): the attribute names of an `Attributes` request are
    // only known as `string`, which would widen the set attributes instead of adding them
    const requestWithoutKnownAttributes: ServerRequest<Record<never, never>> = request;

    const requestWithClientIp = serverRequestHelpers.withAttribute(requestWithoutKnownAttributes, 'clientIp', clientIp);
    const requestWithScheme = serverRequestHelpers.withAttribute(requestWithClientIp, 'scheme', scheme);

    return handler(serverRequestHelpers.withAttribute(requestWithScheme, 'host', host));
  };
};
