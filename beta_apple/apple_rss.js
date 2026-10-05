const { XMLParser, XMLValidator } = require('fast-xml-parser');
const he = require('he');
const { fetchPublisherTranscript, linkedUrls } = require('./publisher_transcript');

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'object' ? String(value?.['#text'] || '') : String(value || '');
const normalise = value => he.decode(text(value)).normalize('NFKC').toLowerCase()
  .replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

function fail(message, status = 404, code = 'RETRIEVAL_FAILED', details = {}) {
  throw Object.assign(new Error(message), { status, code, details });
}

function parseAppleUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('Enter a valid Apple Podcasts episode URL.', 400, 'INVALID_URL'); }
  const showId = url.pathname.match(/\/id(\d+)\/?$/)?.[1];
  const episodeId = url.searchParams.get('i');
  if (url.protocol !== 'https:' || url.hostname !== 'podcasts.apple.com' ||
      !showId || !/^\d+$/.test(episodeId || '')) {
    fail('Use an HTTPS Apple episode link containing idSHOW_ID and ?i=EPISODE_ID.', 400, 'INVALID_URL');
  }
  const region = url.pathname.split('/')[1];
  return { showId, episodeId, country: /^[a-z]{2}$/i.test(region) ? region : 'us' };
}

async function fetchText(value, { allowedHosts, deadline } = {}) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('Unsupported upstream URL.', 502, 'UPSTREAM_ERROR');
  }
  const controller = new AbortController();
  const remaining = deadline ? Math.min(20000, deadline - Date.now()) : 20000;
  if (remaining <= 0) fail('Retrieval time budget exceeded. Try the direct publisher URL.', 502, 'UPSTREAM_ERROR');
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    let current = url;
    let response;
    for (let hop = 0; hop < 6; hop++) {
      if (allowedHosts && (current.protocol !== 'https:' || !allowedHosts.has(current.hostname) ||
          current.username || current.password || (current.port && current.port !== '443'))) {
        fail('Publisher redirected to an unsupported URL.', 502, 'UNSUPPORTED_PUBLISHER');
      }
      response = await fetch(current, { signal: controller.signal, redirect: allowedHosts ? 'manual' : 'follow' });
      if (!allowedHosts || ![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === 5) fail('Invalid or excessive publisher redirects.', 502, 'UPSTREAM_ERROR');
      current = new URL(location, current);
    }
    if (!response.ok) fail(`Could not check the publisher: HTTP ${response.status}.`, 502, 'UPSTREAM_ERROR');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 10 * 1024 * 1024) {
        controller.abort();
        fail('Could not check: feed or transcript exceeds 10 MB.', 502, 'DOWNLOAD_TOO_LARGE');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (error.status) throw error;
    fail(error.name === 'AbortError' ? 'Could not check: upstream request timed out.' :
      'Could not check: Apple or the publisher could not be reached.', 502, 'UPSTREAM_ERROR');
  } finally { clearTimeout(timer); }
}

async function lookup(id, country, extra = {}, download = fetchText) {
  const query = new URLSearchParams({ id, country, ...extra });
  try { return JSON.parse(await download(`https://itunes.apple.com/lookup?${query}`)); }
  catch (error) {
    if (error.status) throw error;
    fail('Apple returned invalid catalog data.', 502, 'UPSTREAM_ERROR');
  }
}

function captionsToText(raw, type) {
  if (type === 'text/plain') return he.decode(raw).trim();
  if (type === 'application/json') {
    let data;
    try { data = JSON.parse(raw); } catch { fail('The linked JSON transcript is invalid.', 502, 'INVALID_TRANSCRIPT'); }
    if (typeof data?.text === 'string') return data.text.trim();
    const segments = Array.isArray(data) ? data : data?.segments;
    if (!Array.isArray(segments) || !segments.every(s => typeof s?.text === 'string')) {
      fail('This JSON transcript format is not supported.', 422, 'UNSUPPORTED_FORMAT');
    }
    return segments.map(s => s.text.trim()).join('\n');
  }
  const cues = [];
  for (const block of raw.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    if (/^\s*(NOTE|STYLE|REGION)(?:\s|$)/.test(block)) continue;
    const lines = block.split('\n');
    const index = lines.findIndex(line => /^\s*(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->/.test(line));
    if (index < 0) continue;
    const cue = he.decode(lines.slice(index + 1).join(' ').replace(/<[^>]*>/g, '')).trim();
    if (cue) cues.push(cue);
  }
  return cues.join('\n');
}

function sameAudio(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // Tracking redirects may differ; require a specific matching media filename.
  try {
    const filename = value => new URL(value).pathname.split('/').pop();
    const file = filename(a);
    return file.length > 12 && /\.(mp3|m4a|ogg)$/i.test(file) && file === filename(b);
  } catch { return false; }
}

async function fetchRssTranscript(appleUrl, episodeTitle = '', episodeDescription = '', download = fetchText) {
  const { showId, episodeId, country } = parseAppleUrl(appleUrl);
  // Show-level episode lookup often works where a bare episode lookup fails.
  const catalog = await lookup(showId, country, { entity: 'podcastEpisode', limit: '200' }, download);
  let show = catalog.results?.find(row => row.feedUrl);
  if (!show) show = (await lookup(showId, country, {}, download)).results?.find(row => row.feedUrl);
  if (!show) fail('No public RSS feed was returned for this show.', 404, 'NO_FEED');
  let episode = catalog.results?.find(row => String(row.trackId) === episodeId && row.kind === 'podcast-episode');
  if (!episode) {
    try {
      episode = (await lookup(episodeId, country, { entity: 'podcastEpisode' }, download)).results?.find(row =>
        String(row.trackId) === episodeId && row.trackName &&
        (!row.collectionId || String(row.collectionId) === showId));
    } catch { /* An exact title can still resolve the RSS episode. */ }
  }
  const xml = await download(show.feedUrl);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    fail('The publisher returned unsupported or invalid RSS XML.', 502, 'INVALID_RSS');
  }
  const feed = parser.parse(xml);
  const channel = feed.rss?.channel;
  const items = list(channel?.item);
  const details = { feedUrl: show.feedUrl, episodeTitle: episode?.trackName || episodeTitle,
    showId, showName: show.collectionName || text(channel?.title) };
  let matches = !episodeTitle.trim() && episode?.episodeUrl ? items.filter(item =>
    sameAudio(item.enclosure?.['@_url'], episode.episodeUrl)) : [];
  if (matches.length !== 1) {
    const title = episodeTitle.trim() || episode?.trackName;
    if (!title) fail('Could not identify the episode. Enter its exact title and retry; no transcript was downloaded.',
      422, 'NEEDS_TITLE', details);
    matches = items.filter(item => normalise(item.title) === normalise(title));
  }
  if (matches.length > 1 && episode?.releaseDate) {
    const date = new Date(episode.releaseDate);
    if (Number.isFinite(date.getTime())) matches = matches.filter(item => {
      const published = new Date(item.pubDate);
      return Number.isFinite(published.getTime()) &&
        published.toISOString().slice(0, 10) === date.toISOString().slice(0, 10);
    });
  }
  // Description is a literal disambiguation hint, never a transcript or AI input.
  if (matches.length > 1 && episodeDescription.trim().length >= 30) {
    const hint = normalise(episodeDescription);
    matches = matches.filter(item => normalise(item.description).includes(hint));
  }
  if (matches.length !== 1) fail(matches.length ?
    'Multiple episodes match. Supply a distinctive description excerpt; no transcript was downloaded.' :
    'The requested episode was not matched in the current RSS feed. Check the exact title; older episodes may be absent.',
  422, matches.length ? 'AMBIGUOUS_EPISODE' : 'EPISODE_NOT_FOUND', details);
  const item = matches[0];
  details.episodeTitle = text(item.title);
  details.audioUrl = item.enclosure?.['@_url'] || '';
  details.episodeNotes = text(item['content:encoded']) || text(item.description);
  details.publisherUrls = [text(item.link), ...linkedUrls(details.episodeNotes, show.feedUrl)].filter(Boolean);
  const namespaces = { ...feed.rss, ...channel, ...item };
  const links = Object.entries(item).filter(([key]) => {
    if (!key.includes(':') || key.split(':').pop() !== 'transcript') return false;
    return namespaces[`@_xmlns:${key.split(':')[0]}`] === 'https://podcastindex.org/namespace/1.0';
  }).flatMap(([, value]) => list(value));
  details.publisherUrls.push(...links.filter(link => /text\/html/i.test(link['@_type'] || '') && link['@_url'])
    .map(link => new URL(link['@_url'], show.feedUrl).href));
  if (!links.length) fail(`Episode found: ${details.episodeTitle}. No publisher transcript link is present in its RSS item. ` +
    'This does not check Apple’s private transcripts or the publisher’s website. No AI summary was generated.',
  404, 'NO_PUBLISHER_TRANSCRIPT', details);
  const supported = ['text/plain', 'text/vtt', 'application/x-subrip', 'application/srt', 'application/json'];
  const candidates = links.map(link => ({ ...link,
    mime: String(link['@_type'] || '').split(';')[0].trim().toLowerCase(),
    language: String(link['@_language'] || text(channel.language)).toLowerCase()
  })).filter(link => !link.language || /^en(?:-|$)/.test(link.language));
  candidates.sort((a, b) => Number(!a.language) - Number(!b.language));
  const eligible = candidates.filter(link => link['@_url'] && supported.includes(link.mime));
  if (!eligible.length) fail('Transcript links exist, but none has an English/unspecified-language format this importer supports.',
    422, 'UNSUPPORTED_TRANSCRIPT', details);
  let lastError;
  for (const link of eligible) {
    try {
      const transcriptUrl = new URL(link['@_url'], show.feedUrl).href;
      const transcript = captionsToText(await download(transcriptUrl), link.mime);
      if (!transcript) fail('The transcript link returned no readable text.', 502, 'INVALID_TRANSCRIPT');
      return { transcript, title: details.episodeTitle, source: appleUrl,
        transcriptSource: 'publisher-rss', transcriptUrl, feedUrl: show.feedUrl,
        inputKind: 'transcript', audioUrl: details.audioUrl };
    } catch (error) { lastError = error; }
  }
  fail(`Transcript link found, but downloading/parsing failed: ${lastError.message}`,
    lastError.status || 502, lastError.code || 'UPSTREAM_ERROR', details);
}

// One overall budget keeps the browser's existing request timeout useful.
async function fetchAppleRssTranscript(appleUrl, episodeTitle = '', episodeDescription = '', options = {}) {
  const deadline = Date.now() + 80000;
  const download = (url, settings = {}) => fetchText(url, { ...settings, deadline });
  let rssError;
  if (appleUrl) {
    try { return await fetchRssTranscript(appleUrl, episodeTitle, episodeDescription, download); }
    catch (error) {
      rssError = error;
      const canFallback = !!error.details?.audioUrl || ['NO_PUBLISHER_TRANSCRIPT', 'UNSUPPORTED_TRANSCRIPT',
        'UNSUPPORTED_FORMAT', 'INVALID_TRANSCRIPT'].includes(error.code);
      if (!canFallback && !options.publisherUrl) throw error;
      if (error.code === 'INVALID_URL') throw error;
    }
  } else if (!options.publisherUrl) fail('Enter an Apple episode URL or publisher episode/transcript URL.', 400, 'INVALID_URL');
  const details = rssError?.details || {};
  try {
    const result = await fetchPublisherTranscript({ ...details,
      episodeTitle: details.episodeTitle || episodeTitle,
      publisherUrl: options.publisherUrl || '', source: appleUrl || options.publisherUrl,
      fetchText: download, fetchYouTubeTranscript: options.fetchYouTubeTranscript });
    return { ...result, feedUrl: details.feedUrl || '', audioUrl: details.audioUrl || '' };
  } catch (error) {
    error.details = { ...details, ...(error.details || {}), rssStatus: rssError?.code || 'not_requested' };
    // Do not return entire show notes to the browser on errors.
    delete error.details.episodeNotes;
    throw error;
  }
}

module.exports = { fetchAppleRssTranscript };
