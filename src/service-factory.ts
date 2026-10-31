import type { Container } from '@chubbyts/chubbyts-dic-types/dist/container';
import { createAbstractFactory } from '@chubbyts/chubbyts-dic-config-factory/dist/dic-config-factory';
import type { Attributes } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
import type { Middleware } from '@chubbyts/chubbyts-http-types/middleware';
import type { ForwardedHeaders, ForwardedResolver, TrustedProxyAttributes } from './middleware.js';
import { createForwardedResolver, createTrustedProxyMiddleware } from './middleware.js';

/**
 * The configuration read by the service factories from `config.chubbyts.trustedProxy` (or
 * `config.chubbyts.trustedProxy.<name>` for named factories), see the arguments of `createForwardedResolver`.
 */
export type TrustedProxyConfig = {
  /** the ips / cidrs of the proxies */
  trustedProxies: Array<string>;
  /** the forwarded header names (`for`, `proto`, `host`), each one replaces its default, `null` disables `proto` and `host` */
  headers?: ForwardedHeaders;
  /** resolve nothing if the request carries no address of the connection (default `true`) */
  requireRemoteAddress?: boolean;
};

// the http-types implementation (e.g. @chubbyts/chubbyts-http) gets shared by all services of the container
const serverRequestHelpersId = 'serverRequestHelpers';

type Config = {
  chubbyts: {
    trustedProxy: TrustedProxyConfig | Record<string, TrustedProxyConfig>;
  };
};

export const forwardedResolverServiceFactory = createAbstractFactory(
  (container: Container, { name, resolveConfig }): ForwardedResolver => {
    const suffix = name ? `.${name}` : '';
    const path = `config.chubbyts.trustedProxy${suffix}`;
    const {
      trustedProxies,
      headers = {},
      requireRemoteAddress = true,
    } = resolveConfig(container.get<Partial<Config>>('config')?.chubbyts?.trustedProxy ?? {}) as TrustedProxyConfig;

    const serverRequestHelpers = container.get<ServerRequestHelpers>(serverRequestHelpersId);

    // createForwardedResolver validates the whole config, the same way as for a direct call
    try {
      return createForwardedResolver(serverRequestHelpers, trustedProxies, headers, requireRemoteAddress);
    } catch (e) {
      // the messages start with the key (`trustedProxies ...`, `headers.for ...`), so the path gets prepended, the
      // class (TypeError for a wrong type) gets kept
      const ErrorClass = e instanceof TypeError ? TypeError : Error;

      throw new ErrorClass(`${path}.${(e as Error).message}`, { cause: e });
    }
  },
);

export const trustedProxyMiddlewareServiceFactory = createAbstractFactory(
  (container: Container, { resolveDependency }): Middleware<Attributes, TrustedProxyAttributes> =>
    // a registered service wins over the shipped factory, so that the resolver can be replaced or shared
    createTrustedProxyMiddleware(
      container.get<ServerRequestHelpers>(serverRequestHelpersId),
      resolveDependency(container, 'trustedProxyForwardedResolver', forwardedResolverServiceFactory),
    ),
);
