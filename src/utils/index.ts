import { FastifyInstance, RegisterOptions } from 'fastify';
import { Readable } from 'node:stream';

import Providers from './providers';

const PASSTHROUGH_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
] as const;

function parseTargetUrl(value?: string | null) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function parseForwardHeaders(value?: string | null) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;

    return Object.entries(parsed).reduce<Record<string, string>>(
      (result, [key, headerValue]) => {
        if (typeof headerValue === 'string' && headerValue.trim()) {
          result[key] = headerValue;
        }

        return result;
      },
      {},
    );
  } catch {
    return {};
  }
}

function buildProxyUrl(url: string, headers: Record<string, string>) {
  const params = new URLSearchParams({
    url,
  });

  if (Object.keys(headers).length) {
    params.set('headers', JSON.stringify(headers));
  }

  return `/utils/media-proxy?${params.toString()}`;
}

function isPlaylistResponse(contentType: string | null, pathname: string) {
  return (
    contentType?.toLowerCase().includes('mpegurl') === true ||
    pathname.toLowerCase().endsWith('.m3u8')
  );
}

function rewriteUriAttributes(
  line: string,
  baseUrl: URL,
  headers: Record<string, string>,
) {
  return line.replace(/URI="([^"]+)"/g, (_, value: string) => {
    const resolvedUrl = new URL(value, baseUrl).toString();
    return `URI="${buildProxyUrl(resolvedUrl, headers)}"`;
  });
}

function rewritePlaylist(content: string, baseUrl: URL, headers: Record<string, string>) {
  return content
    .split(/\r?\n/g)
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return line;
      }

      if (trimmed.startsWith('#')) {
        return rewriteUriAttributes(line, baseUrl, headers);
      }

      return buildProxyUrl(new URL(trimmed, baseUrl).toString(), headers);
    })
    .join('\n');
}

function copyResponseHeaders(
  upstreamHeaders: Headers,
  reply: any,
  isPlaylist: boolean,
) {
  for (const key of PASSTHROUGH_HEADERS) {
    const value = upstreamHeaders.get(key);

    if (!value) {
      continue;
    }

    if (isPlaylist && key === 'content-length') {
      continue;
    }

    reply.header(key, value);
  }

  reply.header('Access-Control-Allow-Origin', '*');

  if (isPlaylist) {
    reply.header('content-type', 'application/vnd.apple.mpegurl; charset=utf-8');
    reply.header('cache-control', 'no-store');
  }
}

function inferMediaContentType(targetUrl: URL, upstreamHeaders: Headers) {
  const upstreamType = upstreamHeaders.get('content-type');

  if (
    targetUrl.searchParams.get('file')?.toLowerCase().endsWith('.mp4') ||
    targetUrl.pathname.toLowerCase().includes('/mp4/')
  ) {
    return 'video/mp4';
  }

  return upstreamType;
}

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  await fastify.register(new Providers().getProviders);

  fastify.get('/media-proxy', async (request: any, reply: any) => {
    const targetUrl = parseTargetUrl(request.query?.url);

    if (!targetUrl) {
      return reply.status(400).send({ error: 'Invalid media source URL.' });
    }

    const forwardHeaders = parseForwardHeaders(request.query?.headers);
    const requestHeaders = new Headers();

    for (const [key, value] of Object.entries(forwardHeaders)) {
      requestHeaders.set(key, value);
    }

    const rangeHeader = request.headers.range;

    if (typeof rangeHeader === 'string' && rangeHeader.trim()) {
      requestHeaders.set('range', rangeHeader);
    }

    const acceptHeader = request.headers.accept;

    if (typeof acceptHeader === 'string' && acceptHeader.trim()) {
      requestHeaders.set('accept', acceptHeader);
    }

    let upstreamResponse: Response;

    try {
      upstreamResponse = await fetch(targetUrl, {
        headers: requestHeaders,
        redirect: 'follow',
      });
    } catch {
      return reply.status(502).send({ error: 'Failed to fetch media source.' });
    }

    if (!upstreamResponse.ok) {
      return reply
        .status(upstreamResponse.status)
        .send({ error: `Upstream media returned HTTP ${upstreamResponse.status}.` });
    }

    const contentType = upstreamResponse.headers.get('content-type');
    const isPlaylist = isPlaylistResponse(contentType, targetUrl.pathname);

    copyResponseHeaders(upstreamResponse.headers, reply, isPlaylist);
    reply.status(upstreamResponse.status);

    if (isPlaylist) {
      const content = await upstreamResponse.text();
      const rewritten = rewritePlaylist(content, targetUrl, forwardHeaders);
      return reply.send(rewritten);
    }

    const inferredContentType = inferMediaContentType(targetUrl, upstreamResponse.headers);

    if (inferredContentType) {
      reply.header('content-type', inferredContentType);
    }

    if (!upstreamResponse.body) {
      return reply.send('');
    }

    return reply.send(Readable.fromWeb(upstreamResponse.body as any));
  });

  fastify.get('/', async (request: any, reply: any) => {
    reply.status(200).send('Welcome to Consumet Utils!');
  });
};

export default routes;
