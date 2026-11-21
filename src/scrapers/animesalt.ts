import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { cacheGet, cacheSet } from '../utils/cache';
import { resolveMegaPlayPlayer } from './anikoto';
import { resolveVdoHide } from '../resolvers/vdohide';

const BASES = ['https://animesalt.cx', 'https://animesalt.to', 'https://animesalt.ac'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export interface AnimeSaltEpisode {
  id: string;
  num: number;
  title: string;
  url: string;
  season?: number;
}

export interface AnimeSaltServer {
  name: string;
  sourceId: string;
  type: 'sub' | 'dub';
  lang?: string;
  audioTrack?: { lang: string; name: string; url: string; default?: boolean };
  qualities?: { label: string; url: string; resolution?: string | null; height?: number | null }[];
}

export interface AnimeSaltStream {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
  mp4?: string | null;
  subtitles?: { lang: string; label?: string; url: string; default?: boolean }[];
  qualities?: { label: string; url: string; resolution?: string | null; height?: number | null; language?: string; type?: string | null; size?: number }[];
  audioTracks?: { lang: string; name: string; url: string; default?: boolean }[];
  selectedAudioLang?: string | null;
  streams?: {
    language: string;
    referer?: string;
    qualities: { label: string; url: string; resolution?: string | null; type?: string | null; size?: number }[];
  }[];
}

// ── HLS master playlist helpers ──────────────────────────────────────────────

interface HlsAudioTrack { lang: string; name: string; url: string; default?: boolean }
interface HlsQuality   { label: string; url: string; resolution?: string | null; height?: number | null; bandwidth?: number }
interface HlsSubtitle  { lang: string; label?: string; url: string; default?: boolean }

function parseHlsAttrList(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi)) {
    attrs[match[1].toUpperCase()] = match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function uniqueByKey<T>(items: T[], key: (item: T) => string): T[] {
  return Array.from(new Map(items.map((item) => [key(item), item])).values());
}

function resolveHlsUrl(uri: string, masterUrl: string): string {
  try { return new URL(uri, masterUrl).toString(); } catch { return uri; }
}

function parseAnimeSaltHlsMaster(master: string, masterUrl: string): { audioTracks: HlsAudioTrack[]; qualities: HlsQuality[]; subtitles: HlsSubtitle[] } {
  const audioTracks: HlsAudioTrack[] = [];
  const qualities: HlsQuality[] = [];
  const subtitles: HlsSubtitle[] = [];
  const lines = master.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(line)) {
      const attrs = parseHlsAttrList(line);
      if (!attrs.URI) continue;
      audioTracks.push({
        lang: attrs.LANGUAGE || attrs.NAME || 'unknown',
        name: attrs.NAME || attrs.LANGUAGE || 'Audio',
        url: resolveHlsUrl(attrs.URI, masterUrl),
        default: /YES/i.test(attrs.DEFAULT || ''),
      });
    }
    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=SUBTITLES/i.test(line)) {
      const attrs = parseHlsAttrList(line);
      if (!attrs.URI) continue;
      subtitles.push({
        lang: attrs.LANGUAGE || attrs.NAME || 'English',
        label: attrs.NAME || attrs.LANGUAGE || 'Subtitle',
        url: resolveHlsUrl(attrs.URI, masterUrl),
        default: /YES/i.test(attrs.DEFAULT || ''),
      });
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseHlsAttrList(line);
      const next = lines.slice(i + 1).find((c) => c.trim() && !c.trim().startsWith('#'))?.trim();
      if (!next || /^audio\//i.test(next)) continue;
      const resolution = attrs.RESOLUTION;
      const height = resolution?.match(/x(\d+)/i)?.[1] ? Number(resolution.match(/x(\d+)/i)?.[1]) : null;
      qualities.push({
        label: height ? `${height}p` : resolution || 'Auto',
        url: resolveHlsUrl(next, masterUrl),
        resolution: resolution ?? null,
        height: height ?? null,
        bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : undefined,
      });
    }
  }
  return {
    audioTracks: uniqueByKey(audioTracks, (t) => `${t.lang}:${t.url}`),
    qualities: uniqueByKey(qualities, (q) => q.url),
    subtitles: uniqueByKey(subtitles, (s) => s.url),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function encode(value: any): string {
  return `animesalt:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

export function decodeAnimeSaltSourceId(value: string): any {
  if (!value.startsWith('animesalt:')) throw new Error('Invalid AnimeSalt sourceId');
  return JSON.parse(Buffer.from(value.slice('animesalt:'.length), 'base64url').toString('utf8'));
}

function abs(url: string, base = BASES[0]): string {
  if (!url || !url.trim() || url === '/' || url === '#') return '';
  try { return new URL(url.trim(), base).toString(); } catch { return url; }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function diceCoeff(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const bg = nb.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      hits++;
      bigrams.set(bg, count - 1);
    }
  }
  return (2 * hits) / (na.length + nb.length - 2);
}

function scoreTitle(query: string, candidate: string, slug = ''): number {
  const na = norm(query);
  const nb = norm(candidate);
  const ns = norm(slug.replace(/[-_]/g, ' '));
  if (!na) return 0;

  // Exact alphanumeric match
  if (na === nb || (ns && na === ns)) return 100;

  // Substring / containment match
  if (nb.includes(na) || na.includes(nb)) {
    const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    return Math.round(75 + lenRatio * 20);
  }
  if (ns && (ns.includes(na) || na.includes(ns))) {
    const lenRatio = Math.min(na.length, ns.length) / Math.max(na.length, ns.length);
    return Math.round(70 + lenRatio * 20);
  }

  // Word-level overlap
  const wordsA = new Set(normalizeTitle(query).split(' '));
  const wordsB = normalizeTitle(candidate).split(' ');
  const hits = wordsB.filter((w) => wordsA.has(w)).length;
  const wordScore = Math.round((hits / Math.max(wordsA.size, wordsB.length, 1)) * 80);

  // Bigram / dice coefficient
  const dice = Math.round(Math.max(diceCoeff(query, candidate), ns ? diceCoeff(query, ns) : 0) * 85);

  return Math.max(wordScore, dice);
}

function generateSearchQueries(title: string, altTitle?: string | null): string[] {
  const rawQueries = [title, altTitle].filter((v): v is string => !!v && v.trim().length > 0 && v !== 'Unknown');
  const queries = new Set<string>();

  for (const q of rawQueries) {
    const clean = q.trim();
    queries.add(clean);

    // Strip season / part / cour suffixes: "Solo Leveling Season 2" -> "Solo Leveling"
    const strippedSeason = clean
      .replace(/\s*[:\-–]\s*(?:season|\bpart|\bcour\b)\s*\d+.*$/i, '')
      .replace(/\s+(?:season|\bpart|\bcour\b)\s*\d+.*$/i, '')
      .replace(/\s+(?:\d+(?:st|nd|rd|th)\s+season|\bthe\s+final\s+season\b).*$/i, '')
      .trim();
    if (strippedSeason && strippedSeason !== clean && strippedSeason.length >= 2) {
      queries.add(strippedSeason);
    }

    // Strip subtitle after colon or dash
    const strippedSub = clean.replace(/\s*[:\-–].*$/, '').trim();
    if (strippedSub && strippedSub !== clean && strippedSub.length >= 2) {
      queries.add(strippedSub);
    }

    // Clean punctuation
    const cleanPunct = clean.replace(/[:\-–_.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanPunct && cleanPunct !== clean) {
      queries.add(cleanPunct);
    }
  }

  return Array.from(queries);
}

async function fetchHtml(pathOrUrl: string): Promise<{ html: string; base: string } | null> {
  const urls = pathOrUrl.startsWith('http')
    ? [pathOrUrl]
    : BASES.map((base) => `${base}${pathOrUrl}`);

  for (const url of urls) {
    try {
      const origin = new URL(url).origin;
      const res = await axios.get(url, {
        headers: { ...HEADERS, Referer: `${origin}/` },
        timeout: 10000,
        responseType: 'text',
        transformResponse: [(data) => data],
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const html = String(res.data);
      if (html.length >= 200) return { html, base: origin };
    } catch {}
  }
  return null;
}

interface SearchHit { title: string; url: string; kind: 'series' | 'movies'; score: number; }

async function searchAnime(title: string, altTitle?: string | null): Promise<SearchHit | null> {
  const cacheKey = `animesalt:search:${norm(title)}:${norm(altTitle || '')}`;
  const cached = cacheGet<SearchHit>(cacheKey);
  if (cached) return cached;

  const queries = generateSearchQueries(title, altTitle);
  const candidates: SearchHit[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    const page = await fetchHtml(`/?s=${encodeURIComponent(query)}`);
    if (!page) continue;
    const $ = cheerio.load(page.html);

    $('article, .aa-cn li, .movies-list article, .post').each((_, el) => {
      const link = $(el).find('a[href*="/series/"], a[href*="/movies/"], a.card-link, a.lnk-blk, .entry-title a').first();
      const href = link.attr('href') || '';
      const m = href.match(/\/(series|movies)\/([^/?#]+)\/?$/i);
      if (!m) return;
      const cleanUrl = abs(href, page.base);
      if (seenUrls.has(cleanUrl)) return;
      seenUrls.add(cleanUrl);

      const titleText = (
        $(el).find('.card-details h3, .entry-title, h3, h2').first().text().replace(/\s+/g, ' ').trim() ||
        link.attr('title') ||
        link.text().replace(/\s+/g, ' ').trim()
      );
      if (!titleText) return;

      const slug = m[2];
      const score = Math.max(
        scoreTitle(query, titleText, slug),
        scoreTitle(title, titleText, slug),
        altTitle ? scoreTitle(altTitle, titleText, slug) : 0
      );

      candidates.push({
        title: titleText,
        url: cleanUrl,
        kind: m[1].toLowerCase() as 'series' | 'movies',
        score,
      });
    });

    if (candidates.some((c) => c.score >= 90)) break;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] && candidates[0].score >= 40 ? candidates[0] : null;
  if (best) cacheSet(cacheKey, best, 'episodes');
  return best;
}

function parseEpisodeLinks(html: string, base: string): AnimeSaltEpisode[] {
  const $ = cheerio.load(html);
  const out: AnimeSaltEpisode[] = [];

  $('a[href*="/episode/"]').each((_, el) => {
    const url = abs($(el).attr('href') || '', base);
    const m = url.match(/-([0-9]+)x([0-9]+)\/?(?:[?#].*)?$/i);
    if (!m) return;
    const season = Number(m[1]);
    const num = Number(m[2]);
    if (!Number.isFinite(num)) return;
    let rawTitle = $(el).find('.entry-title, h2, h3').first().text().replace(/\s+/g, ' ').trim() || $(el).text().replace(/\s+/g, ' ').trim();
    // Strip episode code suffix like "S1E1", "S2E13" that AnimeSalt appends to episode titles
    rawTitle = rawTitle.replace(/\s*S\d+E\d+\s*$/i, '').trim();
    const title = rawTitle || `Episode ${num}`;
    out.push({ id: encode({ url, season, num }), num, season, title, url });
  });

  const seen = new Set<string>();
  return out
    .filter((e) => { if (seen.has(e.url)) return false; seen.add(e.url); return true; })
    .sort((a, b) => (a.season || 1) - (b.season || 1) || a.num - b.num);
}

async function fetchSeasonEpisodes(seriesUrl: string, season: number, postId: string, base: string): Promise<AnimeSaltEpisode[]> {
  if (season === 1) {
    const page = await fetchHtml(seriesUrl);
    return page ? parseEpisodeLinks(page.html, page.base) : [];
  }

  try {
    const res = await axios.get(`${base}/wp-admin/admin-ajax.php`, {
      params: { action: 'action_select_season', season, post: postId },
      headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest', Referer: seriesUrl },
      timeout: 10000,
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    return parseEpisodeLinks(String(res.data), base);
  } catch {
    return [];
  }
}

export async function findAnimeSaltSlug(title: string, altTitle?: string | null): Promise<string | null> {
  const hit = await searchAnime(title, altTitle);
  return hit?.url ?? null;
}

export async function getAnimeSaltEpisodes(input: { title?: string; altTitle?: string | null; siteId?: string }): Promise<AnimeSaltEpisode[]> {
  const title = input.title || '';
  const cacheKey = `animesalt:episodes:${(input.siteId || title).toLowerCase()}`;
  const cached = cacheGet<AnimeSaltEpisode[]>(cacheKey);
  if (cached) return cached;

  const hit = input.siteId && /^https?:\/\//i.test(input.siteId)
    ? { url: input.siteId, kind: input.siteId.includes('/movies/') ? 'movies' as const : 'series' as const }
    : await searchAnime(title, input.altTitle);
  if (!hit) throw new Error('AnimeSalt title not found');

  const page = await fetchHtml(hit.url);
  if (!page) throw new Error('AnimeSalt series page unavailable');

  if (hit.kind === 'movies') {
    const episode = { id: encode({ url: hit.url, season: 1, num: 1 }), num: 1, season: 1, title: 'Movie', url: hit.url };
    cacheSet(cacheKey, [episode], 'episodes');
    return [episode];
  }

  const $ = cheerio.load(page.html);
  const buttons = $('.season-buttons .season-btn[data-post][data-season], .season-buttons a[data-post][data-season]');
  const episodes: AnimeSaltEpisode[] = [];

  if (buttons.length) {
    const seasonTasks: Promise<AnimeSaltEpisode[]>[] = [];
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons.eq(i);
      const season = Number(btn.attr('data-season')) || i + 1;
      const postId = btn.attr('data-post') || '';
      seasonTasks.push(fetchSeasonEpisodes(hit.url, season, postId, page.base));
    }
    const results = await Promise.all(seasonTasks);
    for (const r of results) episodes.push(...r);
  } else {
    episodes.push(...parseEpisodeLinks(page.html, page.base));
  }

  const unique = Array.from(new Map(episodes.map((e) => [e.url, e])).values())
    .sort((a, b) => (a.season || 1) - (b.season || 1) || a.num - b.num);

  cacheSet(cacheKey, unique, 'episodes');
  return unique;
}

function inferTypeFromUrl(url: string): 'sub' | 'dub' {
  const s = url.toLowerCase();
  return /dub|english|hindi|tamil|telugu/.test(s) ? 'dub' : 'sub';
}

/** Map embed URL to a human-readable server provider name */
function inferProviderName(src: string): string | null {
  if (/ravok\.buzz|as-cdn/i.test(src)) return 'MyStream';
  if (/abyssplayer|short\.icu|player\.php\?data=/i.test(src)) return 'Abyss';
  if (/megaplay\.buzz|rapid-cloud/i.test(src)) return 'MegaPlay';
  if (/cybervynx\.com|vdohide|streamhg/i.test(src)) return 'StreamHG';
  return null;
}

export async function getAnimeSaltServers(episodeId: string): Promise<AnimeSaltServer[]> {
  const payload = decodeAnimeSaltSourceId(episodeId);
  const pageUrl = String(payload.url);
  const cacheKey = `animesalt:servers:${pageUrl}`;
  const cached = cacheGet<AnimeSaltServer[]>(cacheKey);
  if (cached) return cached;

  const page = await fetchHtml(pageUrl);
  if (!page) throw new Error('AnimeSalt episode page unavailable');

  const $ = cheerio.load(page.html);
  const serverBtns: { index: number; name: string; info: string }[] = [];
  $('.server-btn, .server-item').each((i, el) => {
    const onclick = $(el).attr('onclick') || '';
    const m = onclick.match(/changeServer\((\d+)\)/);
    const idx = m ? Number(m[1]) : i;
    const sName = $(el).find('.server-name, .name, b, strong').first().text().replace(/\s+/g, ' ').trim() || `SERVER ${idx + 1}`;
    const sInfo = $(el).find('.server-info, .info, span').first().text().replace(/\s+/g, ' ').trim() || '';
    serverBtns.push({ index: idx, name: sName, info: sInfo });
  });

  const rawEntries: { name: string; src: string }[] = [];
  const seen = new Set<string>();

  // Match container divs #options-0, #options-1, etc.
  $('.video.aa-tb, .video-player > div, [id^="options-"]').each((i, el) => {
    const id = $(el).attr('id') || '';
    const m = id.match(/options-(\d+)/);
    const idx = m ? Number(m[1]) : i;
    const iframe = $(el).find('iframe').first();
    const src = abs(iframe.attr('src') || iframe.attr('data-src') || '', page.base);
    if (!src || /about:blank|javascript:|googletagmanager|recaptcha|adsystem/i.test(src)) return;
    // Skip iframes pointing back to animesalt itself (page wrappers, not video players)
    if (/animesalt\.(cx|to|ac|cc)(\/)?($|\?(?!data=))/i.test(src)) return;
    if (/animesalt\.(cx|to|ac|cc)\//i.test(src) && !/player\.php\?data=/i.test(src)) return;
    if (seen.has(src)) return;
    seen.add(src);

    const btn = serverBtns.find((b) => b.index === idx) || serverBtns[i];
    // Build the server label: prefer the .server-info text (the provider name AnimeSalt labels it with),
    // fall back to URL-inferred name, then to raw button text.
    const btnInfo = btn?.info?.trim() || '';
    const urlProvider = inferProviderName(src);
    // Use button info if it looks like a real provider name (not generic/junk like "X", "1", etc.)
    const isValidBtnInfo = btnInfo.length > 1 && !/^[x\d]$/i.test(btnInfo);
    const serverName = isValidBtnInfo ? btnInfo : (urlProvider || (btn ? btn.name : `Server ${idx + 1}`));
    rawEntries.push({ name: serverName, src });
  });

  // Fallback: check any remaining iframes not matched by options-X
  $('iframe[src], iframe[data-src]').each((_, el) => {
    const src = abs($(el).attr('src') || $(el).attr('data-src') || '', page.base);
    if (!src || /about:blank|javascript:|googletagmanager|recaptcha|adsystem/i.test(src)) return;
    // Skip iframes pointing back to animesalt itself (page wrappers, not video players)
    if (/animesalt\.(cx|to|ac|cc)(\/)?($|\?(?!data=))/i.test(src)) return;
    if (/animesalt\.(cx|to|ac|cc)\//i.test(src) && !/player\.php\?data=/i.test(src)) return;
    if (seen.has(src)) return;
    seen.add(src);

    let name = $(el).closest('[data-server], .server, .server-item, li, div').find('.server-name, .name, button').first().text().replace(/\s+/g, ' ').trim();
    if (!name) {
      name = inferProviderName(src) || `Server ${rawEntries.length + 1}`;
    }
    rawEntries.push({ name, src });
  });

  // Some pages have provider URLs in scripts/data attributes
  if (!rawEntries.length) {
    const urls = Array.from(page.html.matchAll(/https?:\/\/[^"'\s<>]+/gi))
      .map((m) => m[0].replace(/&amp;/g, '&'))
      .filter((u) => /abyssplayer|short\.icu|megaplay\.buzz|rapid-cloud|as-cdn\d*\.top|ravok\.buzz|firevideoplayer|cybervynx\.com|player\.php\?data=/i.test(u));
    for (const url of Array.from(new Set(urls))) {
      const name = /abyssplayer|short\.icu/i.test(url) ? 'Abyss'
        : /megaplay|rapid-cloud/i.test(url) ? 'MegaPlay'
        : /cybervynx|vdohide|streamhg/i.test(url) ? 'StreamHG'
        : /as-cdn|firevideoplayer|ravok\.buzz/i.test(url) ? 'MyStream'
        : `Server ${rawEntries.length + 1}`;
      rawEntries.push({ name, src: url });
    }
  }

  const found: AnimeSaltServer[] = [];

  for (const entry of rawEntries) {
    const { name, src } = entry;

    // 1. Abyss Router (player.php?data=...) with per-language links
    const multiLang = decodeAnimeSaltMultiLang(src);
    if (multiLang.length) {
      for (const item of multiLang) {
        const language = normalizeLanguage(item.language);
        const type = language.toLowerCase() === 'japanese' ? 'sub' : 'dub';
        found.push({
          name: `Abyss ${language}`,
          sourceId: encode({ url: src, pageUrl, name: 'Abyss', language, link: item.link }),
          type,
          lang: language,
        });
      }
      continue;
    }

    // 2. Ravok / As-Cdn / MyStream HLS with multi-audio tracks
    if (/\/video\/[a-f0-9]{16,}/i.test(src) || /ravok\.buzz|as-cdn/i.test(src)) {
      const hlsStream = await resolveAsCdn(src, pageUrl).catch(() => null);
      if (hlsStream && hlsStream.audioTracks && hlsStream.audioTracks.length > 0) {
        for (const track of hlsStream.audioTracks) {
          const isJap = /^ja(?:panese)?$/i.test(track.lang) || /^japanese$/i.test(track.name);
          const langName = track.name || track.lang;
          found.push({
            name: `${name} ${langName}`,
            sourceId: encode({ url: src, pageUrl, name, selectedAudioLang: track.lang, audioTrack: track }),
            type: isJap ? 'sub' : 'dub',
            lang: langName,
            audioTrack: track,
            qualities: hlsStream.qualities,
          });
        }
        // No duplicate base entry — per-track entries are sufficient
        continue;
      }
      // Single audio / no multi-audio — add single entry
      if (hlsStream) {
        found.push({
          name,
          sourceId: encode({ url: src, pageUrl, name }),
          type: 'sub',
          lang: 'Japanese',
          qualities: hlsStream.qualities,
        });
        continue;
      }
    }

    // 3. MegaPlay
    if (/megaplay\.buzz|rapid-cloud/i.test(src)) {
      const isDub = /\/dub(?:$|[?#])/i.test(src) || /dub/i.test(name);
      found.push({
        name: isDub ? 'MegaPlay Dub' : 'MegaPlay Sub',
        sourceId: encode({ url: src, pageUrl, name: 'MegaPlay' }),
        type: isDub ? 'dub' : 'sub',
        lang: isDub ? 'English' : 'Japanese',
      });
      continue;
    }

    // 4. StreamHG / CyberVynx / VdoHide
    if (/cybervynx\.com|vdohide|streamhg/i.test(src)) {
      found.push({
        name: 'StreamHG',
        sourceId: encode({ url: src, pageUrl, name: 'StreamHG' }),
        type: 'sub',
        lang: 'Japanese',
      });
      continue;
    }

    // 5. Generic fallback
    found.push({
      name,
      sourceId: encode({ url: src, pageUrl, name }),
      type: inferTypeFromUrl(src),
      lang: /dub|english|hindi|tamil|telugu/i.test(name + ' ' + src) ? 'dub' : 'sub',
    });
  }

  cacheSet(cacheKey, found, 'episodes');
  return found;
}

function parsePlayerjsSubtitles(html: string): HlsSubtitle[] {
  const subtitles: HlsSubtitle[] = [];
  const defaultLang = html.match(/playerjsDefaultSubtitle\s*=\s*["']([^"']+)["']/i)?.[1] || 'English';

  const pjsMatch = html.match(/playerjsSubtitle\s*=\s*["']([^"']+)["']/i);
  if (pjsMatch?.[1]) {
    const rawSubs = pjsMatch[1].split(',');
    for (const item of rawSubs) {
      const trimmed = item.trim();
      const langMatch = trimmed.match(/^\[([^\]]+)\](.*)$/);
      if (langMatch) {
        const lang = langMatch[1].trim();
        const url = langMatch[2].trim();
        if (url) {
          subtitles.push({
            lang,
            label: lang,
            url,
            default: lang.toLowerCase() === defaultLang.toLowerCase(),
          });
        }
      } else if (trimmed.startsWith('http')) {
        subtitles.push({
          lang: defaultLang,
          label: defaultLang,
          url: trimmed,
          default: true,
        });
      }
    }
  }

  for (const match of html.matchAll(/<track[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi)) {
    const trackTag = match[0];
    const url = match[1];
    if (!url || /thumb/i.test(url)) continue;
    const lang = trackTag.match(/(?:srclang|label)=["']([^"']+)["']/i)?.[1] || 'English';
    const isDef = /default/i.test(trackTag);
    subtitles.push({ lang, label: lang, url, default: isDef });
  }

  return uniqueByKey(subtitles, (s) => s.url);
}

// ── Resolvers ────────────────────────────────────────────────────────────────

async function resolveAsCdn(embedUrl: string, pageUrl: string, selectedAudioLang?: string | null): Promise<AnimeSaltStream | null> {
  const match = embedUrl.match(/\/video\/([a-f0-9]{16,})/i);
  if (!match) return null;
  const u = new URL(embedUrl);
  const cacheKey = `animesalt:ascdn:${embedUrl}`;
  const cached = cacheGet<{ master: string; audioTracks: HlsAudioTrack[]; qualities: HlsQuality[]; subtitles: HlsSubtitle[] }>(cacheKey);

  let master = cached?.master;
  let audioTracks = cached?.audioTracks || [];
  let qualities = cached?.qualities || [];
  let subtitles = cached?.subtitles || [];

  if (!master) {
    const postUrl = `${u.origin}/player/index.php?data=${match[1]}&do=getVideo`;
    try {
      const [pageRes, apiRes] = await Promise.all([
        axios.get(embedUrl, {
          headers: { ...HEADERS, Referer: pageUrl || `${BASES[0]}/` },
          timeout: 8000,
          responseType: 'text',
          transformResponse: [(d) => d],
        }).catch(() => null),
        axios.post(postUrl, `hash=${encodeURIComponent(match[1])}&r=${encodeURIComponent(BASES[0] + '/')}`, {
          headers: {
            ...HEADERS,
            Referer: embedUrl,
            Origin: u.origin,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
          responseType: 'json',
        }),
      ]);

      if (pageRes?.data) {
        const htmlSubs = parsePlayerjsSubtitles(String(pageRes.data));
        subtitles.push(...htmlSubs);
      }

      master = apiRes.data?.videoSource || apiRes.data?.securedLink;
      if (!master) return null;

      try {
        const hlsRes = await axios.get(String(master), {
          headers: {
            ...HEADERS,
            Referer: `${u.origin}/`,
            Origin: u.origin,
          },
          timeout: 8000,
          responseType: 'text',
          transformResponse: [(d) => d],
        });
        const parsed = parseAnimeSaltHlsMaster(String(hlsRes.data), String(master));
        audioTracks = parsed.audioTracks;
        qualities = parsed.qualities;
        subtitles.push(...parsed.subtitles);
        subtitles = uniqueByKey(subtitles, (s) => s.url);
      } catch {}

      cacheSet(cacheKey, { master: String(master), audioTracks, qualities, subtitles }, 'stream');
      if (pageUrl && subtitles.length) {
        cacheSet(`animesalt:subs:${pageUrl}`, subtitles, 'stream');
      }
    } catch {
      return null;
    }
  }

  const selectedTrack = selectedAudioLang
    ? audioTracks.find((t) => t.lang.toLowerCase() === selectedAudioLang.toLowerCase() || t.name.toLowerCase() === selectedAudioLang.toLowerCase())
    : undefined;

  return {
    embedUrl,
    m3u8: String(master),
    referer: `${u.origin}/`,
    subtitles,
    qualities,
    audioTracks: selectedTrack ? [selectedTrack] : audioTracks,
    selectedAudioLang: selectedTrack?.lang ?? selectedAudioLang ?? null,
  };
}

interface AbyssQuality {
  language?: string;
  label: string;
  url: string;
  resolution?: string | null;
  type?: string | null;
  size?: number;
}

interface AbyssResult {
  pageUrl: string;
  qualities: AbyssQuality[];
  subtitles?: { lang: string; label?: string; url: string; default?: boolean }[];
}

function decryptAbyssMedia(media: string, userId: string | number, slug: string, md5Id: string | number): string {
  const keyMaterial = `${userId}:${slug}:${md5Id}`;
  const md5Hex = crypto.createHash('md5').update(keyMaterial).digest('hex');
  const mediaIsBase64 = /^[A-Za-z0-9+/=_-]+$/.test(media) && media.length % 4 !== 1;
  const cipherCandidates = [
    Buffer.from(media, 'latin1'),
    ...(mediaIsBase64 ? [Buffer.from(media + '='.repeat((4 - (media.length % 4)) % 4), 'base64')] : []),
  ];

  const attempts = [
    { algorithm: 'aes-128-ctr', key: Buffer.from(md5Hex, 'hex'), iv: Buffer.from(md5Hex, 'hex') },
    { algorithm: 'aes-256-ctr', key: Buffer.from(md5Hex, 'utf8'), iv: Buffer.from(md5Hex.slice(0, 16), 'utf8') },
    { algorithm: 'aes-256-ctr', key: Buffer.from(md5Hex, 'utf8'), iv: Buffer.from(md5Hex.slice(0, 32), 'hex') },
  ];

  for (const cipherBytes of cipherCandidates) {
    for (const attempt of attempts) {
      try {
        const decipher = crypto.createDecipheriv(attempt.algorithm, attempt.key, attempt.iv);
        const decrypted = Buffer.concat([decipher.update(cipherBytes), decipher.final()]).toString('utf8');
        const trimmed = decrypted.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) return decrypted;
      } catch {}
    }
  }
  return '';
}

function abyssNumericKey(value: number): string {
  const bytes = Buffer.from(String(value).split('').map((char) => /\d/.test(char) ? Number(char) : char.charCodeAt(0)));
  return crypto.createHash('md5').update(bytes).digest('hex');
}

function createAbyssSegmentToken(path: string, size: number): string {
  const key = Buffer.from(abyssNumericKey(size), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-ctr', key, key.subarray(0, 16));
  const encrypted = Buffer.concat([cipher.update(path, 'utf8'), cipher.final()]);
  const once = encrypted.toString('base64').replace(/=/g, '');
  return Buffer.from(once, 'utf8').toString('base64').replace(/=/g, '');
}

async function resolveAbyss(embedUrl: string): Promise<AbyssResult | null> {
  let url = embedUrl;
  if (/^https?:\/\/short\.icu\//i.test(url)) {
    url = url.replace(/^https?:\/\/short\.icu/i, 'https://abyssplayer.com');
  }

  const cacheKey = `animesalt:abyss:${url}`;
  const cached = cacheGet<AbyssResult>(cacheKey);
  if (cached) return cached;

  try {
    const pageRes = await axios.get(url, {
      headers: {
        ...HEADERS,
        Origin: 'https://playhydrax.com',
        Referer: 'https://playhydrax.com/',
      },
      timeout: 10000,
      responseType: 'text',
      transformResponse: [(data) => data],
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const pageUrl = String(pageRes.request?.res?.responseUrl || pageRes.config?.url || url);
    const html = String(pageRes.data);
    // AnimeSalt/Abyss has used const/let/var and both quote styles for
    // the base64 payload. Keep the capture tolerant of those markup changes.
    const match = html.match(/(?:const|let|var)\\s+datas\\s*=\\s*["'`]([^"'`]+)["'`]/i)
      || html.match(/datas\s*[:=]\s*["']([A-Za-z0-9+/_=-]{80,})["']/i);
    if (!match?.[1]) return null;

    let qualities: AbyssQuality[] = [];
    const subtitles: { lang: string; label?: string; url: string; default?: boolean }[] = [];

    // 1. Try local offline decryption first (lightning fast, ~0ms)
    try {
      const containerJson = Buffer.from(match[1], 'base64').toString('latin1');
      const container = JSON.parse(containerJson);
      if (container.slug && container.md5_id && container.user_id && container.media) {
        const decrypted = decryptAbyssMedia(container.media, container.user_id, container.slug, container.md5_id);
        if (decrypted) {
          const mediaObj = JSON.parse(decrypted);
          const sources = Array.isArray(mediaObj?.mp4?.sources) ? mediaObj.mp4.sources : [];
          const domains = Array.isArray(mediaObj?.mp4?.domains) ? mediaObj.mp4.domains : [];
          const baseDomain = domains.length ? String(domains[0]).split('.').slice(1).join('.') : 'sssrr.org';

          qualities = sources
            .filter((s: any) => s?.status !== false && s?.size && s?.res_id && s?.sub)
            .map((s: any) => {
              const path = `/mp4/${container.md5_id}/${s.res_id}/${s.size}?v=${container.slug}`;
              const token = createAbyssSegmentToken(path, Number(s.size));
              const directUrl = `https://${s.sub}.${baseDomain}/sora/${s.size}/${token}`;
              return {
                label: String(s.label || `${s.res_id}p`) + (s.codec ? ' ' + s.codec : ''),
                url: directUrl,
                resolution: s.label ? String(s.label) : null,
                type: s.label ? String(s.label) : null,
                size: Number(s.size) || 0,
              };
            });
        }
      }
    } catch {}

    // 2. Fallback to external enc-dec API if local decryption didn't produce qualities
    if (!qualities.length) {
      try {
        const decRes = await axios.post(
          'https://enc-dec.app/api/dec-abyss',
          { text: match[1] },
          {
            headers: {
              'User-Agent': UA,
              Origin: 'https://playhydrax.com',
              Referer: 'https://playhydrax.com/',
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            timeout: 10000,
            responseType: 'json',
          },
        );

        const sources = decRes.data?.result?.sources ?? decRes.data?.sources ?? [];
        if (Array.isArray(sources)) {
          qualities = sources
            .filter((s: any) => s?.url && s.status !== false)
            .map((s: any) => ({
              label: String(s.type || s.label || '1080p') + (s.codec ? ' ' + s.codec : ''),
              url: String(s.url),
              resolution: s.type ? String(s.type) : null,
              type: s.type ? String(s.type) : null,
              size: Number(s.size) || 0,
            }));
        }

        const tracks = decRes.data?.result?.tracks ?? decRes.data?.tracks ?? [];
        if (Array.isArray(tracks)) {
          for (const t of tracks) {
            if (t?.file && t.kind !== 'thumbnails') {
              subtitles.push({
                lang: String(t.label || t.srclang || 'English'),
                label: String(t.label || 'Subtitle'),
                url: String(t.file),
                default: t.default === true,
              });
            }
          }
        }
      } catch {}
    }

    if (!qualities.length) return null;
    const result: AbyssResult = { pageUrl, qualities, subtitles };
    cacheSet(cacheKey, result, 'stream');
    return result;
  } catch {
    return null;
  }
}

function normalizeLanguage(value: string): string {
  // Provider labels may include suffixes such as "English Dub" or "Japanese Sub".
  const s = value.trim().toLowerCase().replace(/\b(?:dub|sub|audio)\b/g, '').replace(/[()[\]]/g, '').trim();
  if (!s) return 'Unknown';
  if (s === 'en' || s === 'eng' || s === 'english') return 'English';
  if (s === 'ja' || s === 'jpn' || s === 'japanese' || s === 'japan') return 'Japanese';
  if (s === 'hi' || s === 'hin' || s === 'hindi') return 'Hindi';
  if (s === 'ta' || s === 'tam' || s === 'tamil') return 'Tamil';
  if (s === 'te' || s === 'tel' || s === 'telugu') return 'Telugu';
  return value.trim().replace(/\b\w/g, (ch) => ch.toUpperCase()) || 'Unknown';
}

function decodeAnimeSaltMultiLang(url: string): { language: string; link: string }[] {
  try {
    const data = new URL(url).searchParams.get('data');
    if (!data) return [];
    const json = Buffer.from(data, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item: any) => item?.link).map((item: any) => ({
      language: String(item.language || 'Unknown'),
      link: String(item.link),
    }));
  } catch {
    return [];
  }
}

function pickBestAbyssQuality(qualities: AbyssQuality[]): AbyssQuality | null {
  if (!qualities.length) return null;
  const hls = qualities.filter((q) => /\.m3u8(?:$|\?)/i.test(q.url));
  const pool = hls.length ? hls : qualities;
  return pool.slice().sort((a, b) => {
    const ar = parseInt(a.resolution?.match(/\d{3,4}/)?.[0] || '0', 10);
    const br = parseInt(b.resolution?.match(/\d{3,4}/)?.[0] || '0', 10);
    return br - ar || (b.size || 0) - (a.size || 0);
  })[0] || null;
}

export async function getAnimeSaltStream(sourceId: string): Promise<AnimeSaltStream | null> {
  const payload = decodeAnimeSaltSourceId(sourceId);
  const url = String(payload.url);
  const pageUrl = String(payload.pageUrl || url);

  // 1. Single-language Abyss link (from multi-language router) or full router
  const languages = payload.link && payload.language
    ? [{ language: String(payload.language), link: String(payload.link) }]
    : decodeAnimeSaltMultiLang(url);

  if (languages.length) {
    const results = await Promise.all(languages.map(async ({ language, link }) => {
      const abyss = await resolveAbyss(link);
      return abyss ? { language, ...abyss } : null;
    }));

    const streams = results.filter((r): r is { language: string; pageUrl: string; qualities: AbyssQuality[]; subtitles?: any[] } => !!r);
    const flattened = streams.flatMap((stream) => stream.qualities.map((quality) => ({ language: stream.language, ...quality })));
    const allSubtitles = streams.flatMap((stream) => stream.subtitles ?? []);
    const requestedLanguage = payload.language ? normalizeLanguage(String(payload.language)) : null;
    const preferredPool = requestedLanguage
      ? flattened.filter((q) => normalizeLanguage(q.language || '') === requestedLanguage)
      : flattened.filter((q) => normalizeLanguage(q.language || '') === 'English');
    // Never silently substitute another audio language. That caused an Abyss
    // Dub server to return the Japanese/MyStream stream when its own decode failed.
    const preferred = pickBestAbyssQuality(preferredPool)
      || (!requestedLanguage ? pickBestAbyssQuality(flattened) : null);

    const targetEmbed = payload.link || url;
    if (preferred) {
      const isHls = /\.m3u8(?:$|\?)/i.test(preferred.url);
      let subs = allSubtitles;
      if (!subs.length && pageUrl) {
        const cachedSubs = cacheGet<HlsSubtitle[]>(`animesalt:subs:${pageUrl}`);
        if (cachedSubs?.length) subs = cachedSubs;
      }
      return {
        embedUrl: targetEmbed,
        m3u8: isHls ? preferred.url : null,
        mp4: !isHls ? preferred.url : null,
        referer: streams.find((s) => s.language === preferred.language)?.pageUrl || 'https://player.abyssplayer.com/',
        subtitles: subs,
        qualities: flattened,
        streams: streams.map((stream) => ({ language: stream.language, referer: stream.pageUrl, qualities: stream.qualities })),
      };
    }

    return null;
  }

  // 2. Direct AbyssPlayer embed URL
  if (/abyssplayer|short\.icu/i.test(url)) {
    const abyss = await resolveAbyss(url);
    if (abyss && abyss.qualities.length) {
      const preferred = pickBestAbyssQuality(abyss.qualities);
      const isHls = preferred ? /\.m3u8(?:$|\?)/i.test(preferred.url) : false;
      let subs = abyss.subtitles ?? [];
      if (!subs.length && pageUrl) {
        const cachedSubs = cacheGet<HlsSubtitle[]>(`animesalt:subs:${pageUrl}`);
        if (cachedSubs?.length) subs = cachedSubs;
      }
      return {
        embedUrl: url,
        m3u8: isHls && preferred ? preferred.url : null,
        mp4: !isHls && preferred ? preferred.url : null,
        referer: abyss.pageUrl || 'https://player.abyssplayer.com/',
        subtitles: subs,
        qualities: abyss.qualities,
      };
    }
  }

  // 3. Ravok / As-Cdn stream
  const asCdn = await resolveAsCdn(url, pageUrl, payload.selectedAudioLang ? String(payload.selectedAudioLang) : null);
  if (asCdn) return asCdn;

  // 4. MegaPlay stream (using shared player with full decryption and subtitles)
  if (/megaplay\.buzz|rapid-cloud/i.test(url)) {
    try {
      const mega = await resolveMegaPlayPlayer(url);
      if (mega && mega.m3u8) {
        return {
          embedUrl: url,
          m3u8: mega.m3u8,
          referer: mega.referer || 'https://megaplay.buzz/',
          subtitles: (mega.subtitles ?? []).map((s) => ({
            lang: s.lang || 'English',
            label: s.lang || 'Subtitle',
            url: s.url,
            default: s.default ?? false,
          })),
        };
      }
    } catch {}
  }

  // 5. StreamHG / CyberVynx / VdoHide
  if (/cybervynx\.com|vdohide|streamhg/i.test(url)) {
    try {
      const vdo = await resolveVdoHide(url);
      if (vdo && vdo.m3u8) {
        return {
          embedUrl: url,
          m3u8: vdo.m3u8,
          referer: vdo.referer || 'https://cybervynx.com/',
          subtitles: (vdo.subtitles ?? []).map((s) => ({
            lang: s.lang,
            label: s.lang,
            url: s.url,
            default: s.default,
          })),
          qualities: vdo.qualities.map((q) => ({
            label: q.label,
            url: q.url,
            height: q.height ?? null,
            bandwidth: q.bandwidth,
          })),
        };
      }
    } catch {}
  }

  return null;
}
