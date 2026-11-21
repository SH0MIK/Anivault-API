import axios from 'axios';

export interface VdoHideSubtitle {
  lang: string;
  url: string;
  default: boolean;
}

export interface VdoHideQuality {
  label: string;
  url: string;
  width?: number;
  height?: number;
  bandwidth?: number;
}

export interface VdoHideAudioTrack {
  lang: string;
  name: string;
  url?: string;
  default: boolean;
}

export interface VdoHideResult {
  embedUrl: string;
  m3u8: string;
  subtitles: VdoHideSubtitle[];
  qualities: VdoHideQuality[];
  audioTracks: VdoHideAudioTrack[];
  poster: string | null;
  title: string | null;
  referer: string;
  type: 'hls';
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function extractObject(source: string, assignment: RegExp): Record<string, any> | null {
  const match = assignment.exec(source);
  if (!match || match.index === undefined) return null;

  const start = source.indexOf('{', match.index);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      const json = source.slice(start, i + 1);
      try {
        return JSON.parse(json);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseMasterPlaylist(text: string): { qualities: VdoHideQuality[]; audioTracks: VdoHideAudioTrack[] } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const qualities: VdoHideQuality[] = [];
  const audioTracks: VdoHideAudioTrack[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/i.test(line)) {
      const attr = (name: string) => line.match(new RegExp('(?:^|[,])\\s*' + name + '="([^"]*)"', 'i'))?.[1];
      const uri = attr('URI');
      const name = attr('NAME') || attr('LANGUAGE') || 'Audio';
      audioTracks.push({
        name,
        lang: attr('LANGUAGE') || name,
        ...(uri ? { url: new URL(uri, 'https://vdohls.com/').toString() } : {}),
        default: /DEFAULT=YES/i.test(line),
      });
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bandwidth = line.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
      let next = i + 1;
      while (next < lines.length && lines[next].startsWith('#')) next++;
      if (next >= lines.length) continue;

      const height = resolution ? Number(resolution[2]) : undefined;
      const width = resolution ? Number(resolution[1]) : undefined;
      qualities.push({
        label: height ? `${height}p` : bandwidth ? `${Math.round(Number(bandwidth[1]) / 1000)} kbps` : 'Auto',
        url: new URL(lines[next], 'https://vdohls.com/').toString(),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(bandwidth ? { bandwidth: Number(bandwidth[1]) } : {}),
      });
    }
  }

  qualities.sort((a, b) => (b.height ?? b.bandwidth ?? 0) - (a.height ?? a.bandwidth ?? 0));
  return { qualities, audioTracks };
}

/**
 * Resolve a VdoHide embed (including fembed.co embeds) into its live HLS
 * master playlist and subtitle tracks. Playlist URLs are resolved on demand;
 * they must not be persisted because the provider can rotate its IDs.
 */
export async function resolveVdoHide(embedUrl: string): Promise<VdoHideResult | null> {
  try {
    const embed = new URL(embedUrl);
    if (!/^https?:$/.test(embed.protocol)) return null;

    const response = await axios.get(embedUrl, {
      headers: { ...HEADERS, Referer: `${embed.origin}/` },
      timeout: 12000,
      responseType: 'text',
    });
    const html = String(response.data ?? '');
    const config = extractObject(html, /(?:window\s*\.\s*)?PLAYER_CONFIG\s*=/);

    const vdoId = String(config?.vdoId || embed.pathname.split('/').filter(Boolean).pop() || '');
    if (!/^[\w-]+$/.test(vdoId)) return null;

    const playlistHost = String(config?.node?.playlist || 'vdohls.com').replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (!/^[a-z0-9.-]+$/i.test(playlistHost)) return null;

    const m3u8 = `https://${playlistHost}/${vdoId}/playlist.m3u8`;
    const tracks = Array.isArray(config?.tracks) ? config.tracks : [];
    const subtitles: VdoHideSubtitle[] = tracks
      .filter((track: any) => typeof track?.file === 'string' && /^https?:\/\//i.test(track.file))
      .map((track: any) => ({
        lang: String(track.label || track.name || track.srclang || 'Subtitle'),
        url: String(track.file),
        default: track.default === true,
      }));

    let qualities: VdoHideQuality[] = [];
    let audioTracks: VdoHideAudioTrack[] = [];
    try {
      const playlist = await axios.get(m3u8, {
        headers: { ...HEADERS, Referer: `${embed.origin}/`, Origin: embed.origin },
        timeout: 10000,
        responseType: 'text',
      });
      ({ qualities, audioTracks } = parseMasterPlaylist(String(playlist.data ?? '')));
    } catch {
      // Return the live master URL even if metadata probing fails; the HLS
      // proxy/player can retry it when playback starts.
    }

    return {
      embedUrl,
      m3u8,
      subtitles,
      qualities,
      audioTracks,
      poster: typeof config?.poster === 'string' ? config.poster : null,
      title: (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim() || null,
      referer: `${embed.origin}/`,
      type: 'hls',
    };
  } catch (error) {
    console.warn('[vdohide] resolveVdoHide failed:', (error as Error).message);
    return null;
  }
}
