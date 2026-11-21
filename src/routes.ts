import { Router, Request, Response } from 'express';
import axios from 'axios';
import https from 'https';
import { malToAnilist, getSiteIds, getSiteIdsByMal, searchAnilist, SiteIds } from './utils/mapper';
import { cacheStats } from './utils/cache';
import { resolveEmbed } from './resolvers/megacloud';

import { getHeavenEpisodes, getHeavenServers, getHeavenStream } from './scrapers/animeheaven';
import { getAnikotoEpisodes, getAnikotoEpisodesById, getAnikotoServers, getAnikotoEmbedUrl, searchAnikoto } from './scrapers/anikoto';
import { getMegaPlayStream } from './scrapers/megaplay';
import { getDesidubEpisodes, getDesidubServers, getDesidubStream } from './scrapers/desidub';
import { getReanimeEpisodes, getReanimeServers, getReanimeStream } from './scrapers/reanime';
import { getAnimeDetails, getEpisodes as getMalEpisodes, getEpisode as getMalEpisode, getAllEpisodes as getAllMalEpisodes, getCharacters, getCharacterDetails, getAnimePictures, getCharacterPictures, getAnimeThemes, getAnimeVideos, getRecommendations, searchAnime, getExternalLinks, getStreamingPlatforms, debugSearchHtml, MalEpisode } from './scrapers/mal';
import { getSeasonNow, getTopBanners, getStreamingEpisodes, AniListStreamingEpisode, getAnimeImages as getAnilistAnimeImages } from './scrapers/anilist';
import { getEpisodeThumbnail as getTmdbEpisodeThumbnail, getEpisodeData as getTmdbEpisodeData, getShowEpisodeCount as getTmdbEpisodeCount, getAnimeImages as getTmdbAnimeImages, extractSeasonHint } from './scrapers/tmdb';
import { getKitsuAnimeId, getEpisodeThumbnail as getKitsuEpisodeThumbnail, getEpisodeData as getKitsuEpisodeData, getAnimeImages as getKitsuAnimeImages } from './scrapers/kitsu';

const router = Router();

const SOURCES = ['animeheaven', 'anikoto', 'desidub', 'reanime', 'megaplay'] as const;
type Source = typeof SOURCES[number];

function publicBase(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

export function proxiedHlsUrl(req: Request, url: string, ref?: string, audioLang?: string | null, playlistKey?: string | null): string {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  const audioParam = audioLang ? `&audio=${encodeURIComponent(audioLang)}` : '';
  const keyParam = playlistKey ? `&pk=${encodeURIComponent(playlistKey)}` : '';
  return `${publicBase(req)}/api/proxy/hls?url=${encodeURIComponent(url)}${refParam}${audioParam}${keyParam}`;
}

function proxiedVideoUrl(req: Request, url: string, ref?: string): string {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  return `${publicBase(req)}/api/proxy/video?url=${encodeURIComponent(url)}${refParam}`;
}


export function proxiedSubtitleUrl(req: Request, url: string, ref?: string): string {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  return `${publicBase(req)}/api/proxy/subtitle?url=${encodeURIComponent(url)}${refParam}`;
}


function decodeFlixPlaylist(text: string, playlistKey?: string): string {
  if (text.trim().startsWith('#EXTM3U') || !playlistKey) return text;
  try {
    const key = Buffer.from(playlistKey, 'base64');
    const encrypted = Buffer.from(text.trim(), 'base64');
    if (!key.length || !encrypted.length) return text;
    const out = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) out[i] = encrypted[i] ^ key[i % key.length];
    const decoded = out.toString('utf8');
    return decoded.startsWith('#EXTM3U') ? decoded : text;
  } catch {
    return text;
  }
}

function unwrapFlixSegment(url: string, body: Buffer): Buffer {
  if (!/\.webp(?:$|\?)|\.png(?:$|\?)/i.test(url)) return body;
  const isWebp = body.length >= 12 && body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46 && body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50;
  const isPng = body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47 && body[4] === 0x0d && body[5] === 0x0a && body[6] === 0x1a && body[7] === 0x0a;
  if (!isWebp && !isPng) return body;
  const payload = Buffer.from(body.subarray(isWebp ? 12 : 8));
  if (payload[0] === 0x47) return payload;
  const mask = [157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197];
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 15];
  return payload;
}

function rewriteHlsPlaylist(req: Request, body: string, sourceUrl: string, ref?: string, audioLang?: string, playlistKey?: string): string {
  const base = new URL(sourceUrl);
  const proxyUri = (uri: string) => proxiedHlsUrl(req, new URL(uri, base).toString(), ref, audioLang, playlistKey);
  const lines = body.split(/\r?\n/);
  const requestedAudio = audioLang?.toLowerCase();
  const audioLineMatches = (line: string) => {
    if (!requestedAudio) return true;
    const language = line.match(/LANGUAGE="([^"]+)"/i)?.[1]?.toLowerCase();
    const name = line.match(/NAME="([^"]+)"/i)?.[1]?.toLowerCase();
    return language === requestedAudio || name === requestedAudio;
  };
  let hasDefaultAudio = false;
  for (const line of lines) {
    if (line.includes('#EXT-X-MEDIA:TYPE=AUDIO') && audioLineMatches(line) && line.includes('DEFAULT=YES')) {
      hasDefaultAudio = true;
      break;
    }
  }
  let firstAudioMarked = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    let processedLine = line;
    if (trimmed.includes('#EXT-X-MEDIA:TYPE=AUDIO') && requestedAudio && !audioLineMatches(trimmed)) return null;
    if (!hasDefaultAudio && !firstAudioMarked && trimmed.includes('#EXT-X-MEDIA:TYPE=AUDIO')) {
      processedLine = processedLine.replace(/DEFAULT=NO/g, 'DEFAULT=YES').replace(/AUTOSELECT=NO/g, 'AUTOSELECT=YES');
      firstAudioMarked = true;
    }
    if (processedLine.trim().startsWith('#') && processedLine.includes('URI=')) {
      return processedLine.replace(/URI="([^"]+)"/g, (_m, uri) => 'URI="' + proxyUri(uri) + '"');
    }
    if (processedLine.trim().startsWith('#')) return processedLine;
    return proxyUri(trimmed);
  }).filter((line): line is string => line !== null).join('\n');
}

async function resolveAlId(anilistId?: string, malId?: string): Promise<number | null> {
  if (anilistId) return parseInt(anilistId);
  if (malId) return malToAnilist(parseInt(malId)); // returns null (not throw) if AniList is down
  return null;
}

// Resolve full SiteIds from whichever id was given. Tries AniList first
// (richer data: zoro/gogoanime via Anify); if AniList is
// down/unreachable and we only have a malId, falls back to the MAL-only
// path so search -> info -> episodes keeps working end to end.
async function resolveSiteIds(anilistId?: string, malId?: string): Promise<SiteIds | null> {
  const alId = await resolveAlId(anilistId, malId);
  if (alId) {
    const info = await getSiteIds(alId);
    if (info && info.title !== 'Unknown') return info;
    // If AniList metadata is unavailable but the caller supplied a MAL ID,
    // retain the public API's MAL-only fallback for title-based providers.
    if (!malId && info) return info;
  }
  if (malId) return getSiteIdsByMal(parseInt(malId));
  return null;
}

async function fetchEpisodes(source: Source, siteIds: any, overrides: { heavenId?: string } = {}): Promise<{ episodes: any[]; siteId: string; error?: string }> {
  const zoroId = siteIds.siteIds?.zoro as string | undefined;
  const heavenId = overrides.heavenId || (siteIds.siteIds?.animeheaven as string | undefined);

  if (source === 'animeheaven') {
    if (!heavenId) return { episodes: [], siteId: '', error: 'Not indexed on AnimeHeaven' };
    return { episodes: await getHeavenEpisodes(heavenId), siteId: heavenId };
  }
  if (source === 'anikoto') {
    const slug = siteIds.siteIds?.anikoto as string | undefined;
    if (!slug) return { episodes: [], siteId: '', error: 'Not indexed on Anikoto' };
    return { episodes: await getAnikotoEpisodes(slug), siteId: slug };
  }
  if (source === 'desidub') {
    const slug = siteIds.siteIds?.desidub as string | undefined;
    if (!slug) return { episodes: [], siteId: '', error: 'Not indexed on DesiDub' };
    return { episodes: await getDesidubEpisodes(slug), siteId: slug };
  }
  if (source === 'reanime') {
    const title = siteIds.title as string | undefined;
    if (!title || title === 'Unknown') return { episodes: [], siteId: '', error: 'Could not resolve an anime title for Re:Anime' };
    try {
      const episodes = await getReanimeEpisodes({ anilistId: siteIds.anilistId, malId: siteIds.malId, title, altTitle: siteIds.altTitle });
      return { episodes, siteId: siteIds.anilistId ? String(siteIds.anilistId) : String(siteIds.malId || title) };
    } catch (error) {
      return { episodes: [], siteId: '', error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (source === 'megaplay') {
    const malId = Number(siteIds.malId);
    if (!Number.isFinite(malId) || malId <= 0) return { episodes: [], siteId: '', error: 'MegaPlay requires a valid MAL ID' };
    const details = await getAnimeDetails(malId);
    const count = Number(details?.episodes);
    if (!Number.isFinite(count) || count <= 0) return { episodes: [], siteId: String(malId), error: 'Could not determine episode count for MegaPlay' };
    return { episodes: Array.from({ length: count }, (_, i) => ({ num: i + 1, id: String(i + 1), title: `Episode ${i + 1}` })), siteId: String(malId) };
  }
  return { episodes: [], siteId: '', error: 'Unknown source' };
}

router.get('/search', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const results = await searchAnilist(q);
    return res.json({ query: q, count: results.length, results, source: 'anilist' });
  } catch (e) {
    // AniList unreachable/down -- fall back to our own MAL scraper.
    // Shape-compatible with the AniList result (id/coverImage/status/format
    // just come back null since MAL search doesn't carry them), plus
    // `source: 'mal'` so the frontend can tell which path served the result.
    try {
      const malResults = await searchAnime(q, 10);
      const results = malResults.map((m) => ({
        id: null,
        malId: m.malId,
        title: m.title,
        coverImage: m.image ?? '',
        episodes: m.episodes,
        status: null,
        format: m.type,
      }));
      return res.json({ query: q, count: results.length, results, source: 'mal', warning: 'AniList is currently unavailable -- showing MAL search results' });
    } catch (e2) {
      return res.status(500).json({ error: 'Search failed', detail: String(e2) });
    }
  }
});

router.get('/info', async (req: Request, res: Response) => {
  const { anilistId, malId } = req.query;
  if (!anilistId && !malId) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=' });
  try {
    const info = await resolveSiteIds(anilistId as string, malId as string);
    if (!info) return res.status(404).json({ error: 'Anime not found' });

    const anikoto = await fetchEpisodes('anikoto', info);
    const episodeCount = anikoto.error ? null : anikoto.episodes.length;

    return res.json({
      anilistId: info.anilistId,
      malId: info.malId,
      title: info.title,
      episodeCount,
      siteIds: info.siteIds,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Streaming-source episode list (animeheaven/anikoto/desidub episode
// IDs, used by /servers and /watch to locate a playable episode). Not to be
// confused with the singular /episode route further down, which is the
// MAL-metadata + thumbnail combined lookup.
router.get('/episodes', async (req: Request, res: Response) => {
  const { anilistId, malId, source = 'anikoto', heavenId } = req.query;
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
  try {
    if (source === 'animeheaven' && heavenId && !anilistId && !malId) {
      const episodes = await getHeavenEpisodes(String(heavenId));
      return res.json({ anilistId: null, malId: null, title: null, source, siteId: String(heavenId), count: episodes.length, episodes });
    }

    const siteIds = await resolveSiteIds(anilistId as string, malId as string);
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve site IDs' });
    const result = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
    if (result.error) return res.status(404).json({ error: result.error });
    return res.json({ anilistId: siteIds.anilistId, malId: siteIds.malId, title: siteIds.title, source, siteId: result.siteId, count: result.episodes.length, episodes: result.episodes });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// Direct Anikoto lookup. Unlike /servers, this route accepts the site's
// own numeric anime ID or watch slug and never invokes MAL/AniList mapping.
router.get('/servers/v2', async (req: Request, res: Response) => {
  const rawId = req.query.anikotoId ?? req.query.id ?? req.query.slug;
  const anikotoId = typeof rawId === 'string' ? rawId.trim() : '';
  const epRaw = typeof req.query.ep === 'string' ? req.query.ep : '';
  const type = typeof req.query.type === 'string' ? req.query.type : 'sub';

  if (!anikotoId) return res.status(400).json({ error: 'Provide ?anikotoId= with an Anikoto numeric ID or watch slug' });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(anikotoId)) {
    return res.status(400).json({ error: 'anikotoId must be a numeric ID or Anikoto watch slug' });
  }
  if (!epRaw) return res.status(400).json({ error: 'Missing ?ep=' });
  const epNum = Number(epRaw);
  if (!Number.isInteger(epNum) || epNum < 1) return res.status(400).json({ error: '?ep must be a positive integer' });
  if (!['sub', 'dub', 'raw', 'all'].includes(type)) {
    return res.status(400).json({ error: 'type must be: sub, dub, raw, all' });
  }

  try {
    const episodes = await getAnikotoEpisodesById(anikotoId);
    const episode = episodes.find((item) => Math.round(item.num) === epNum);
    if (!episode) {
      return res.status(404).json({ error: `Episode ${epNum} not found on Anikoto`, animeId: anikotoId });
    }

    const allServers = await getAnikotoServers(episode.id);
    const servers = type === 'all' ? allServers : allServers.filter((server) => server.type === type);
    return res.json({
      animeId: anikotoId,
      siteId: anikotoId,
      episode: epNum,
      type,
      source: 'anikoto',
      servers: servers.map((server) => ({
        name: server.name,
        sourceId: server.sourceId,
        type: server.type,
      })),
    });
  } catch (error: any) {
    return res.status(502).json({
      error: 'Direct Anikoto server lookup failed',
      detail: error?.message || String(error),
      animeId: anikotoId,
    });
  }
});

// TEMPORARY: diagnostic payload for investigating missing Anikoto mappings.
// Enable with ?debug=1 on /servers. Remove after the lookup issue is resolved.
async function buildAnikotoDebug(siteIds: any, malId?: string) {
  let malDetails: Awaited<ReturnType<typeof getAnimeDetails>> | null = null;
  let malDetailsError: string | null = null;
  if (malId) {
    try {
      malDetails = await getAnimeDetails(Number(malId));
    } catch (error) {
      malDetailsError = String(error);
    }
  }

  const titles = Array.from(new Set([
    siteIds?.title,
    siteIds?.altTitle,
    malDetails?.titleEnglish,
    malDetails?.title,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length >= 4)));

  const searches = await Promise.all(titles.map(async (query) => {
    try {
      const candidates = await searchAnikoto(query);
      return { query, candidateCount: candidates.length, candidates: candidates.slice(0, 30) };
    } catch (error) {
      return { query, error: String(error), candidates: [] };
    }
  }));

  return {
    temporary: true,
    stage: 'site-id-mapping',
    resolved: {
      malId: siteIds?.malId ?? null,
      anilistId: siteIds?.anilistId ?? null,
      title: siteIds?.title ?? null,
      altTitle: siteIds?.altTitle ?? null,
      anikotoId: siteIds?.siteIds?.anikoto ?? null,
    },
    malDetails: malDetails
      ? { title: malDetails.title, titleEnglish: malDetails.titleEnglish, titleJapanese: malDetails.titleJapanese }
      : malDetailsError ? { error: malDetailsError } : null,
    searches,
  };
}

router.get('/servers', async (req: Request, res: Response) => {
  const { anilistId, malId, ep, type = 'sub', source = 'anikoto', heavenId, providerAnimeId, episodeId, episodeSession } = req.query;
  if (!ep) return res.status(400).json({ error: 'Missing ?ep=' });
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  const epNum = parseInt(ep as string);
  if (isNaN(epNum)) return res.status(400).json({ error: '?ep must be a number' });
  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });

  try {
    const siteIds = heavenId && source === 'animeheaven'
      ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: String(heavenId) } }
      : await resolveSiteIds(anilistId as string, malId as string);
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve site IDs' });

    const epResult = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
    if (epResult.error) {
      const debug = req.query.debug === '1' && source === 'anikoto'
        ? await buildAnikotoDebug(siteIds, malId as string | undefined)
        : undefined;
      return res.status(404).json({ error: epResult.error, ...(debug ? { debug } : {}) });
    }
    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return res.status(404).json({ error: `Episode ${epNum} not found` });

    let allServers: any[] = [];
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id, `https://animeheaven.me/anime.php?${epResult.siteId}`);
    if (source === 'anikoto') allServers = await getAnikotoServers(episode.id);
    if (source === 'desidub') allServers = await getDesidubServers(episode.id);
    if (source === 'reanime') allServers = await getReanimeServers(episode.id);
    if (source === 'megaplay') allServers = [{ name: 'MegaPlay Direct', sourceId: String(epNum), type: type === 'dub' ? 'dub' : 'sub' }];

    const filtered = type === 'all' ? allServers : allServers.filter((s: any) => s.type === type);
    return res.json({
      anilistId: siteIds.anilistId,
      malId: siteIds.malId,
      title: siteIds.title,
      episode: epNum,
      type,
      source,
      siteId: epResult.siteId,
      servers: filtered.map((s: any) => {
        return {
          name: s.name,
          sourceId: s.sourceId,
          type: s.type,
          ...(s.lang ? { lang: s.lang } : {}),
          ...(s.audioTrack ? { audioTrack: { ...s.audioTrack, hlsProxyUrl: s.audioTrack.url ? proxiedHlsUrl(req, s.audioTrack.url) : null } } : {}),
          ...(s.qualities ? { qualities: s.qualities.map((quality: any) => {
            const hls = /\.m3u8(?:$|\?)/i.test(String(quality.url || '')) || /\/hls\//i.test(String(quality.url || ''));
            return { ...quality, hlsProxyUrl: hls ? proxiedHlsUrl(req, quality.url) : null, mp4ProxyUrl: !hls ? proxiedVideoUrl(req, quality.url) : null };
          }) } : {}),
        };
      }),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

async function watchHandler(req: Request, res: Response, directAnikotoId?: string) {
  const source = req.params.source ?? (directAnikotoId ? 'anikoto' : '');
  const id = req.params.id ?? directAnikotoId ?? '';
  const { ep, type } = req.params;
  const preferredServer = req.query.server as string | undefined;
  const heavenOverride = req.query.heavenId as string | undefined;

  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
  const epNum = parseInt(ep);
  if (isNaN(epNum)) return res.status(400).json({ error: 'ep must be a number' });
  if (!['sub', 'dub', 'raw'].includes(type)) return res.status(400).json({ error: 'type must be: sub, dub, raw' });

  const directAnikoto = source === 'anikoto' && Boolean(directAnikotoId);
  const directHeavenId = source === 'animeheaven' && !id.startsWith('mal-') && !/^\d+$/.test(id);
  const anilistId = directHeavenId || id.startsWith('mal-') ? undefined : id;
  const malId = id.startsWith('mal-') ? id.replace('mal-', '') : undefined;

  try {
    const siteIds = directAnikoto
      ? { anilistId: null, malId: null, title: null, siteIds: { anikoto: directAnikotoId } }
      : directHeavenId
        ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: id } }
        : await resolveSiteIds(anilistId, malId);
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve anime' });

    if (source === 'megaplay') {
      const stream = await getMegaPlayStream(siteIds.malId, siteIds.anilistId, epNum, type as 'sub' | 'dub');
      if (!stream) return res.status(502).json({ error: `MegaPlay failed to resolve a stream for episode ${epNum}`, source: 'megaplay' });
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        server: 'MegaPlay Direct',
        availableServers: ['MegaPlay Direct'],
        embedUrl: stream.embedUrl,
        m3u8: stream.m3u8,
        hlsProxyUrl: stream.m3u8 ? proxiedHlsUrl(req, stream.m3u8, stream.referer) : null,
        playbackMode: stream.m3u8 ? 'hls' : 'iframe',
        iframeOnly: !stream.m3u8,
        subtitles: (stream.subtitles ?? []).map((s: any) => ({ ...s, url: proxiedSubtitleUrl(req, s.url, stream.referer) })),
        intro: null,
        outro: null,
        note: stream.m3u8 ? null : 'No HLS stream extracted; use embedUrl in an iframe.',
      });
    }

    const epResult = directAnikoto
      ? { episodes: await getAnikotoEpisodesById(directAnikotoId as string), siteId: directAnikotoId as string, error: undefined }
      : await fetchEpisodes(source as Source, siteIds, { heavenId: heavenOverride });
    if (epResult.error) return res.status(404).json({ error: epResult.error });

    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return res.status(404).json({ error: `Episode ${epNum} not found` });

    let allServers: any[] = [];
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'anikoto') allServers = await getAnikotoServers(episode.id);
    if (source === 'desidub') allServers = await getDesidubServers(episode.id);
    if (source === 'reanime') allServers = await getReanimeServers(episode.id);

    const filtered = type === 'all'
      ? allServers
      : allServers.filter((s: any) => s.type === type);
    if (!filtered.length) return res.status(404).json({ error: `No ${type} stream available on ${source} for ep ${epNum}` });

    // `strict=1` alongside `server=` restricts to ONLY that server (no
    // fallback to others) — useful for testing a single server in isolation
    // rather than the default "prefer this one, but fall back if it fails"
    // behavior used in production playback.
    const strict = req.query.strict === '1' || req.query.strict === 'true';
    let candidates = filtered;
    if (preferredServer && strict) {
      candidates = filtered.filter((s: any) => s.name.toLowerCase().includes(preferredServer.toLowerCase()));
      if (!candidates.length) {
        return res.status(404).json({ error: `No server matching "${preferredServer}" found`, availableServers: filtered.map((s: any) => s.name) });
      }
    } else if (preferredServer) {
      candidates = [...filtered].sort((a: any, b: any) => {
        const aM = a.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
        const bM = b.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
        return aM - bM;
      });
    }

    let embedResult: any = null;
    let usedServer = '';
    let fallbackIframeResult: any = null;
    let fallbackIframeServer = '';
    for (const server of candidates) {
      let raw: any = null;
      try {
        if (source === 'animeheaven') raw = await getHeavenStream(server.sourceId, server.referer);
        if (source === 'anikoto') raw = await getAnikotoEmbedUrl(server.sourceId);
        if (source === 'desidub') raw = await getDesidubStream(server.sourceId);
        if (source === 'reanime') raw = await getReanimeStream(server.sourceId);
      } catch (err) {
        console.error(`[/watch/${source}] server ${server.name} failed:`, err);
        continue;
      }
      if (!raw) continue;
      // Prefer direct streams; preserve the first iframe as a last resort,
      // but keep trying later providers for playable HLS/MP4 (private API flow).
      if (raw.m3u8 || raw.mp4 || raw.streamUrl) {
        embedResult = raw;
        usedServer = server.name;
        break;
      }
      if (!fallbackIframeResult && raw.embedUrl) {
        fallbackIframeResult = raw;
        fallbackIframeServer = server.name;
      }
    }
    if (!embedResult && fallbackIframeResult) {
      embedResult = fallbackIframeResult;
      usedServer = fallbackIframeServer;
    }
    if (!embedResult) {
      const msg = strict && preferredServer ? `Server "${preferredServer}" failed to resolve a stream` : 'All servers failed';
      return res.status(502).json({ error: msg, triedServers: candidates.map((s: any) => s.name) });
    }

    if (source === 'animeheaven') {
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        siteId: epResult.siteId,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: embedResult.embedUrl,
        streamUrl: proxiedVideoUrl(req, embedResult.streamUrl),
        rawStreamUrl: embedResult.streamUrl,
        mp4: embedResult.mp4,
        mp4ProxyUrl: proxiedVideoUrl(req, embedResult.mp4),
        m3u8: null,
        hlsProxyUrl: null,
        playbackMode: 'mp4',
        iframeOnly: false,
        subtitles: [],
        note: 'AnimeHeaven currently exposes direct MP4 sources, not m3u8/HLS.',
      });
    }

    // Anikoto's embed resolution (getAnikotoEmbedUrl) already fully resolves
    // the stream internally — Megacloud/Megaplay decryption for regular
    // servers, or a direct CDN m3u8 for the Kiwi Mapper side-channel — so
    // it skips the generic resolveEmbed() fallback below.
    if (source === 'anikoto') {
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: embedResult.embedUrl,
        m3u8: embedResult.m3u8 ?? null,
        hlsProxyUrl: embedResult.m3u8 ? proxiedHlsUrl(req, embedResult.m3u8, embedResult.referer) : null,
        playbackMode: embedResult.m3u8 ? 'hls' : 'iframe',
        iframeOnly: !embedResult.m3u8,
        subtitles: (embedResult.subtitles ?? []).map((s: any) => ({
          ...s,
          url: proxiedSubtitleUrl(req, s.url, embedResult.referer),
        })),
        intro: null,
        outro: null,
        note: embedResult.m3u8 ? null : 'No m3u8 extracted — use embedUrl in an iframe.',
      });
    }

    if (source === 'desidub') {
      const isHls = Boolean(embedResult.m3u8);
      const isMp4 = Boolean(embedResult.mp4);
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: embedResult.embedUrl,
        m3u8: embedResult.m3u8 ?? null,
        hlsProxyUrl: isHls ? proxiedHlsUrl(req, embedResult.m3u8, embedResult.referer) : null,
        mp4: embedResult.mp4 ?? null,
        mp4ProxyUrl: isMp4 ? proxiedVideoUrl(req, embedResult.mp4, embedResult.referer) : null,
        playbackMode: isHls ? 'hls' : isMp4 ? 'mp4' : 'iframe',
        iframeOnly: !isHls && !isMp4,
        subtitles: (embedResult.subtitles ?? []).map((s: any) => ({
          ...s,
          url: proxiedSubtitleUrl(req, s.url, embedResult.referer),
        })),
        intro: null,
        outro: null,
        note: isHls || isMp4 ? null : 'No direct stream extracted — use embedUrl in an iframe.',
      });
    }

    if (source === 'reanime') {
      const isHls = Boolean(embedResult.m3u8);
      return res.json({
        anilistId: siteIds.anilistId, malId: siteIds.malId, title: siteIds.title,
        episode: epNum, type, source, siteId: epResult.siteId, server: usedServer,
        availableServers: filtered.map((s: any) => s.name), embedUrl: embedResult.embedUrl,
        m3u8: embedResult.m3u8 ?? null,
        hlsProxyUrl: isHls ? proxiedHlsUrl(req, embedResult.m3u8, embedResult.referer, embedResult.selectedAudioLang, embedResult.playlistKey) : null,
        playbackMode: isHls ? 'hls' : 'iframe', iframeOnly: !isHls,
        selectedAudioLang: embedResult.selectedAudioLang ?? null,
        audioTracks: (embedResult.audioTracks ?? []).map((track: any) => ({
          ...track, hlsProxyUrl: track.url ? proxiedHlsUrl(req, track.url, embedResult.referer, track.lang, embedResult.playlistKey) : null,
        })),
        qualities: (embedResult.qualities ?? []).map((quality: any) => ({
          ...quality, hlsProxyUrl: proxiedHlsUrl(req, quality.url, embedResult.referer, embedResult.selectedAudioLang, embedResult.playlistKey),
        })),
        subtitles: (embedResult.subtitles ?? []).map((subtitle: any) => ({
          ...subtitle, url: proxiedSubtitleUrl(req, subtitle.url, embedResult.referer),
        })),
        intro: embedResult.intro ?? null, outro: embedResult.outro ?? null,
        thumbnailsVtt: embedResult.thumbnailsVtt ?? null, videoTitle: embedResult.videoTitle ?? null,
        note: isHls ? null : 'No direct HLS stream extracted; use embedUrl in an iframe.',
      });
    }


    return res.json({
      malId,
      title: details ? (details.titleEnglish || details.title) : null,
      count: episodes.length,
      episodes,
    });
  } catch (e: any) {
    return res.status(502).json({ error: 'Combined episode fetch failed', detail: e?.message || String(e) });
  }
});

router.get('/health', (_req, res) => {
  // Unified with anivault.co's /healthz shape ({ status, checks, external })
  // so status.anivault.co can render both services the same way.
  //
  // Note: `sources` below is a static list of configured scraper backends,
  // not a live reachability check against animeheaven/anikoto
  // themselves — probing those would mean firing real scrape requests on
  // every health check, which risks tripping their own rate limits/WAFs.
  // Worth adding later as opt-in, lower-frequency probes if that's wanted.
  const stats = cacheStats();
  const process_: { ok: boolean; label: string; detail: string; badges: { label: string; value: string }[]; critical: boolean } = {
    ok: true,
    label: 'Scraper Process',
    detail: 'API process is running and serving requests.',
    badges: [{ label: 'Uptime', value: `${Math.floor(process.uptime() / 60)}m` }],
    critical: true,
  };
  const cache: { ok: boolean; label: string; detail: string; badges: { label: string; value: string }[]; critical: boolean } = {
    ok: true,
    label: 'Response Cache',
    detail: 'In-memory cache is active.',
    badges: [
      { label: 'Keys', value: String(stats.keys ?? 0) },
      { label: 'Hits', value: String(stats.hits ?? 0) },
      { label: 'Misses', value: String(stats.misses ?? 0) },
    ],
    critical: false,
  };

  res.json({
    status: 'ok',
    checks: { process: process_, cache },
    external: {},
    meta: { version: '1.1.0-anikoto', sources: SOURCES },
    timestamp: new Date().toISOString(),
  });
});

export default router;
