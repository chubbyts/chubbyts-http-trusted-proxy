# chubbyts-http-trusted-proxy

[![CI](https://github.com/chubbyts/chubbyts-http-trusted-proxy/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/chubbyts/chubbyts-http-trusted-proxy/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/chubbyts/chubbyts-http-trusted-proxy/badge.svg?branch=master)](https://coveralls.io/github/chubbyts/chubbyts-http-trusted-proxy?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fchubbyts%2Fchubbyts-http-trusted-proxy%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/chubbyts/chubbyts-http-trusted-proxy/master)
[![npm-version](https://img.shields.io/npm/v/@chubbyts/chubbyts-http-trusted-proxy.svg)](https://www.npmjs.com/package/@chubbyts/chubbyts-http-trusted-proxy)

[![bugs](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=bugs)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![code_smells](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=code_smells)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![coverage](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=coverage)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![duplicated_lines_density](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=duplicated_lines_density)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![ncloc](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=ncloc)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![sqale_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=sqale_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![alert_status](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=alert_status)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![reliability_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=reliability_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![security_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=security_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![sqale_index](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=sqale_index)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)
[![vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-trusted-proxy&metric=vulnerabilities)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-trusted-proxy)

## Description

A trusted proxy middleware for [@chubbyts/chubbyts-http-types][2]: resolves the client ip, scheme and host from the
forwarded headers (`x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`) of trusted proxies into request
attributes.

It works with any implementation of the types (e.g. [@chubbyts/chubbyts-http][6]): the request headers get read and
the attributes get set through the injected helpers only.

## Requirements

 * node: >=22
 * [@chubbyts/chubbyts-dic-config-factory][5]: ^1.0.1
 * [@chubbyts/chubbyts-dic-types][3]: ^2.3.1
 * [@chubbyts/chubbyts-http-types][2]: ^4.0.0

## Installation

Through [NPM](https://www.npmjs.com) as [@chubbyts/chubbyts-http-trusted-proxy][1].

```ts
npm i @chubbyts/chubbyts-http-trusted-proxy@^1.0.0
```

## Usage

Behind a reverse proxy (nginx, traefik, a load balancer, ...) the server only sees the proxy, the client data arrives
within the forwarded headers, which any client can send as well. The middleware decides which entries of these headers
to trust and passes the request on with the `clientIp`, `scheme` and `host` attributes set, so that every other part
(rate limiting, logging, access control, url generation, ...) reads them from one place instead of parsing headers.

```ts
import { createResponseFactory, createServerRequestFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createResponseHelpers, createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { TrustedProxyAttributes } from '@chubbyts/chubbyts-http-trusted-proxy/middleware';
import {
  DEFAULT_FORWARDED_HEADERS,
  createForwardedResolver,
  createTrustedProxyMiddleware,
} from '@chubbyts/chubbyts-http-trusted-proxy/middleware';

const serverRequestFactory = createServerRequestFactory();
const serverRequestHelpers = createServerRequestHelpers();
const responseFactory = createResponseFactory();
const responseHelpers = createResponseHelpers();

// the ips / cidrs of the proxies: the entries of x-forwarded-for get walked from the right, the first one not within
// the ranges is the client (robust against a varying number of hops)
const trustedProxyMiddleware = createTrustedProxyMiddleware(
  serverRequestHelpers,
  createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8', '::1']),
);

const handler: Handler<TrustedProxyAttributes> = async (serverRequest) => {
  // each one string | undefined: the unresolved ones are undefined
  const { clientIp, scheme, host } = serverRequest.attributes;

  return responseHelpers.withHeader(responseFactory(200), 'x-client', `${clientIp} ${scheme}://${host}`);
};

(async () => {
  const serverRequest = serverRequestHelpers.withAttribute(
    serverRequestHelpers.withHeader(
      serverRequestHelpers.withHeader(
        serverRequestHelpers.withHeader(
          serverRequestFactory('GET', 'https://example.com/'),
          'x-forwarded-for',
          '203.0.113.1, 10.0.0.1',
        ),
        'x-forwarded-proto',
        'https',
      ),
      'x-forwarded-host',
      'example.com',
    ),
    // the address of the connection, as set by the server (see security)
    'remoteAddress',
    '10.0.0.2',
  );

  const response = await trustedProxyMiddleware(serverRequest, handler);
})();
```

Register the middleware **before** any middleware that reads the attributes. Requests without a resolvable client ip
(no `x-forwarded-for`, only trusted entries, or a first untrusted entry which is not a valid ip like `unknown` or
`ip:port`) get `undefined` attributes. The middleware always sets all three attributes (the unresolved ones as
`undefined`), so that nothing set before it survives. A subnet matching every ip (`0.0.0.0/0`, `::/0`) gets rejected,
as it would trust every entry and never resolve anything, an empty list as well, as it would trust no entry and resolve
the nearest proxy as client ip, the entries get trimmed, an entry which is not a string, not a valid ip or cidr or one
with a zone id throws. Ipv4 mapped ipv6 addresses (`::ffff:10.0.0.1`) match ipv4 subnets, ipv4 mapped ipv6 subnets
(`::ffff:10.0.0.0/104`) are ipv4 subnets (`10.0.0.0/8`), any other ipv6 subnet matches ipv6 addresses only (`::/8`
does not trust every ipv4).

The `clientIp` gets canonicalized (lowercased and compressed, `2001:DB8:0:0::1` as `2001:db8::1`, ipv4 mapped ipv6
addresses as ipv4, `::ffff:203.0.113.1` as `203.0.113.1`), so that the same client always resolves to the same string,
no matter how a hop wrote it (rate limit keys, allowlists, logs). An ipv6 address with a zone id (`fe80::1%eth0`) is
not a valid ip.

The scheme and host get only resolved when a client ip was resolved: the entry of the proxy which appended the client
ip, counted from the right (proxies appending to all the headers, so that `x-forwarded-for` entries the client sent
along do not shift it), if the header has as many entries as hops, the last (the one the nearest proxy set) otherwise.
The scheme gets lowercased and must be `http` or `https`. The host must be a syntactically valid host (a hostname, an
ipv4 or a bracketed ipv6, each with an optional port from 1 to 65535, a hostname ending with a numeric label must be a
valid ipv4, so `127.1` or `2130706433` are not) and gets canonicalized: lowercased, without the trailing dot
(`example.com.` as `example.com`), an ipv6 compressed, the port without leading zeros (`:0080` as `:80`, a default
port is kept, as it depends on the scheme). Everything else resolves `undefined`.

### Security

The trust is anchored at the address of the connection, the `remoteAddress` attribute (a string, `undefined` counts
as not set, a port gets stripped) as set by the server or a middleware in front, so nothing else may set it (run the
middleware before the router, a route placeholder `{remoteAddress}` would let the client choose it): a connection from
outside the trusted ranges counts as the client itself, its address is the `clientIp` and the headers get ignored. An
address which is not a valid ip (junk, a non string) resolves nothing, the middleware never falls back to the headers.
A request without any address of the connection resolves nothing (fail closed), as the middleware cannot verify that
the last hop was a trusted proxy. Mind that the bridges (e.g. [@chubbyts/chubbyts-http-node][7]) do not set the
attribute, set it while bridging, out of the socket of the connection:

```ts
const serverRequest = serverRequestHelpers.withAttribute(
  nodeRequestToServerRequest(nodeRequest),
  'remoteAddress',
  nodeRequest.socket.remoteAddress,
);
```

If the address of the connection is not available at all, disable the check explicitly with the fourth argument, the
server must then not be reachable except through the proxies:

```ts
createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], DEFAULT_FORWARDED_HEADERS, false);
```

Either way, the proxies must set (or strip) all the forwarded headers, as any header they do not touch is supplied by
the client: a proxy passing the client's `x-forwarded-proto` / `x-forwarded-host` through lets the client choose them,
the middleware cannot tell. The `clientIp` is always a valid ip and the `scheme` always `http` or `https`, but the
`host` is only checked for its syntax: before using it for url generation, redirects, cors or links within mails,
check it against the hosts the application serves (an allowlist, mind that the host contains the port if one was
requested), so that a passed through `x-forwarded-host` cannot poison generated urls:

```ts
const { host } = serverRequest.attributes;

if (!['example.com', 'www.example.com', 'example.com:8443'].includes(host ?? '')) {
  return responseFactory(400);
}
```

The middleware sets attributes only: the forwarded headers, the `host` header and the `uri` of the request stay as
they are, so any code reading them directly (instead of the attributes) still sees what the client sent. The reset of
the attributes relies on the `withAttribute` of the implementation storing an `undefined` value (as
[@chubbyts/chubbyts-http][6] does) or removing the attribute.

The RFC 7239 `Forwarded` header (`for=...;proto=...;host=...`) is not supported, only the de-facto `x-forwarded-*`
headers (or single value ones like `x-real-ip`, see below): if the proxies send `Forwarded`, configure them to send the
`x-forwarded-*` headers as well.

### Headers

The third argument replaces the header names (each one optional, `null` disables `proto` and `host`, `for` cannot be
disabled, an invalid header name throws), useful for a proxy setting a single value header like `x-real-ip`:

```ts
createForwardedResolver(serverRequestHelpers, ['10.0.0.0/8'], { for: 'x-real-ip', proto: 'x-forwarded-proto', host: null });
```

### Service factories (chubbyts-dic-config)

The package ships service factories (abstract factories built on [chubbyts-dic-config-factory][5]) for a [chubbyts-dic-config][4] (or any [chubbyts-dic-types][3] compatible) container within `@chubbyts/chubbyts-http-trusted-proxy/service-factory`, configured through `config.chubbyts.trustedProxy`. The implementation of the types gets read from the service `serverRequestHelpers`, which has to be registered:

```ts
import type { ConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createContainerByConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import type { TrustedProxyAttributes } from '@chubbyts/chubbyts-http-trusted-proxy/middleware';
import type { TrustedProxyConfig } from '@chubbyts/chubbyts-http-trusted-proxy/service-factory';
import { trustedProxyMiddlewareServiceFactory } from '@chubbyts/chubbyts-http-trusted-proxy/service-factory';
import type { Attributes } from '@chubbyts/chubbyts-http-types/message';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';

const container = createContainerByConfigFactory({
  chubbyts: {
    trustedProxy: {
      trustedProxies: ['10.0.0.0/8', '::1'],
      // headers: { for: 'x-forwarded-for', proto: 'x-forwarded-proto', host: 'x-forwarded-host' },
      // requireRemoteAddress: true,
    } satisfies TrustedProxyConfig,
  },
  dependencies: {
    factories: new Map<string, ConfigFactory>([
      ['serverRequestHelpers', () => createServerRequestHelpers()],
      ['trustedProxyMiddleware', trustedProxyMiddlewareServiceFactory()],
    ]),
  },
})();

const trustedProxyMiddleware = container.get<Middleware<Attributes, TrustedProxyAttributes>>('trustedProxyMiddleware');
```

The `trustedProxyMiddlewareServiceFactory` uses the service `trustedProxyForwardedResolver` of the container if registered, and creates it through the shipped `forwardedResolverServiceFactory` otherwise. Register it under its name to replace it or to share it with other services.

#### With names

To serve different parts of an application behind different proxies (a public load balancer, an internal one, ...), the same factories can be registered multiple times with a name: the config is then read from `config.chubbyts.trustedProxy.<name>` and the name gets appended to each service id (`trustedProxyMiddlewarepublic`, `trustedProxyForwardedResolverpublic`, ...).

```ts
const container = createContainerByConfigFactory({
  chubbyts: {
    trustedProxy: {
      public: { trustedProxies: ['10.0.0.0/8', '::1'] },
      internal: { trustedProxies: ['192.168.0.0/16'], headers: { for: 'x-real-ip', host: null } },
    } satisfies Record<string, TrustedProxyConfig>,
  },
  dependencies: {
    factories: new Map<string, ConfigFactory>([
      // serverRequestHelpers like above
      ['trustedProxyMiddlewarepublic', trustedProxyMiddlewareServiceFactory('public')],
      ['trustedProxyMiddlewareinternal', trustedProxyMiddlewareServiceFactory('internal')],
    ]),
  },
})();

const publicTrustedProxyMiddleware = container.get<Middleware<Attributes, TrustedProxyAttributes>>('trustedProxyMiddlewarepublic');
const internalTrustedProxyMiddleware = container.get<Middleware<Attributes, TrustedProxyAttributes>>('trustedProxyMiddlewareinternal');
```

## Copyright

2026 Dominik Zogg

[1]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-trusted-proxy
[2]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-types
[3]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-types
[4]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-config
[5]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-config-factory
[6]: https://www.npmjs.com/package/@chubbyts/chubbyts-http
[7]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-node
