import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import { load } from 'cheerio';
import Kwik from '@consumet/extensions/dist/extractors/kwik';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

const ANIMEPAHE_BASE_URL = 'https://animepahe.si';
const KWIK_REFERER = 'https://kwik.cx/';
const PAHE_WIN_REDIRECT_PATTERN =
  /a\.redirect"\)\.attr\("href","(https:\/\/[^"]+)"/i;

function buildAnimePaheHeaders(sessionId?: string | false) {
  return {
    authority: 'animepahe.si',
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    cookie: '__ddg2_=;',
    dnt: '1',
    referer: sessionId
      ? `${ANIMEPAHE_BASE_URL}/anime/${sessionId}`
      : ANIMEPAHE_BASE_URL,
    'sec-ch-ua':
      '"Not A(Brand";v="99", "Microsoft Edge";v="121", "Chromium";v="121"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
  };
}

async function resolveAnimePaheDownloadUrl(kwik: Kwik, downloadUrl: string) {
  let effectiveUrl = downloadUrl;

  if (/^https?:\/\/pahe\.win\//i.test(downloadUrl)) {
    const shortlinkResponse = await fetch(downloadUrl, {
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: ANIMEPAHE_BASE_URL,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      },
    });
    const shortlinkHtml = await shortlinkResponse.text();
    const match = shortlinkHtml.match(PAHE_WIN_REDIRECT_PATTERN);

    if (match?.[1]) {
      effectiveUrl = match[1];
    } else {
      console.warn(
        '[animepahe/watch] pahe shortlink redirect pattern not found:',
        shortlinkHtml.slice(0, 500),
      );
    }
  }

  return (await kwik.getDirectDownloadLink(new URL(effectiveUrl))) ?? effectiveUrl;
}

async function fetchAnimePaheSourcesWithFallback(episodeId: string) {
  const animeId = episodeId.split('/')[0];
  const response = await fetch(`${ANIMEPAHE_BASE_URL}/play/${episodeId}`, {
    headers: buildAnimePaheHeaders(animeId),
  });

  if (!response.ok) {
    throw new Error(`AnimePahe play page returned HTTP ${response.status}`);
  }

  const data = await response.text();
  const $ = load(data);
  const kwik = new Kwik();
  const sources: Array<Record<string, unknown>> = [];
  const downloads: Array<{ quality: string; url: string }> = [];
  const streamLinks = $('div#resolutionMenu > button')
    .map((_, element) => ({
      audio: $(element).attr('data-audio'),
      quality: $(element).text().trim(),
      url: $(element).attr('data-src'),
    }))
    .get()
    .filter((item) => Boolean(item.url));
  const downloadLinks = $('div#pickDownload > a')
    .map((_, element) => ({
      quality: $(element).text().trim(),
      url: $(element).attr('href'),
    }))
    .get()
    .filter((item) => Boolean(item.url));

  for (const link of streamLinks) {
    if (!link.url) {
      continue;
    }

    try {
      const extracted = await kwik.extract(new URL(link.url));
      const source = extracted[0];

      if (!source) {
        continue;
      }

      source.quality = link.quality;
      source.isDub = link.audio === 'eng';
      sources.push(source as Record<string, unknown>);
    } catch (error) {
      console.warn(
        '[animepahe/watch] stream extraction skipped:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  for (const download of downloadLinks) {
    if (!download.url) {
      continue;
    }

    try {
      const directUrl = await resolveAnimePaheDownloadUrl(kwik, download.url);

      downloads.push({
        quality: download.quality,
        url: directUrl ?? download.url,
      });
    } catch (error) {
      console.warn(
        '[animepahe/watch] direct download fallback used:',
        error instanceof Error ? error.message : String(error),
      );
      downloads.push({
        quality: download.quality,
        url: download.url,
      });
    }
  }

  return {
    download: downloads,
    headers: {
      Referer: KWIK_REFERER,
    },
    sources,
  };
}

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const animepahe = new ANIME.AnimePahe();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: `Welcome to the animepahe provider: check out the provider's website @ ${animepahe.toString.baseUrl}`,
      routes: ['/:query', '/info/:id', '/watch/:episodeId', '/recent-episodes'],
      documentation: 'https://docs.consumet.org/#tag/animepahe',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `animepahe:search:${query}`,
            async () => await animepahe.search(query),
            REDIS_TTL,
          )
        : await animepahe.search(query);

      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({
        message: 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get(
    '/recent-episodes',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const page = (request.query as { page: number }).page;
      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `animepahe:recent-episodes:${page}`,
              async () => await animepahe.fetchRecentEpisodes(page),
              REDIS_TTL,
            )
          : await animepahe.fetchRecentEpisodes(page);

        reply.status(200).send(res);
      } catch (error) {
        reply.status(500).send({
          message: 'Something went wrong. Contact developer for help.',
        });
      }
    },
  );

  fastify.get('/info/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const episodePage = (request.query as { episodePage: number }).episodePage;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `animepahe:info:${id}:${episodePage}`,
            async () => await animepahe.fetchAnimeInfo(id, episodePage),
            REDIS_TTL,
          )
        : await animepahe.fetchAnimeInfo(id, episodePage);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/watch', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.query as { episodeId: string }).episodeId;

    if (typeof episodeId === 'undefined')
      return reply.status(400).send({ message: 'episodeId is required' });

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `animepahe:watch:${episodeId}`,
            async () => await fetchAnimePaheSourcesWithFallback(episodeId),
            REDIS_TTL,
          )
        : await fetchAnimePaheSourcesWithFallback(episodeId);

      reply.status(200).send(res);
    } catch (err) {
      console.error(
        '[animepahe/watch] fetchEpisodeSources failed:',
        err instanceof Error ? err.stack || err.message : String(err),
      );
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });
};

export default routes;
