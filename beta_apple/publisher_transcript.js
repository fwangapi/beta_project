// Publisher adapters: extract transcript sections, never turn show notes into speech.
const cheerio = require('cheerio');
const he = require('he');

const HOSTS = new Set(['theverge.com', 'www.theverge.com', 'practicalai.show',
  'practicalai.fm', 'changelog.com', 'www.eetimes.com', 'eetimes.com',
  'wandb.ai', 'site.wandb.ai', 'wandb.me', 'deepmind.google', 'www.thecube.net',
  'thecube.net', 'siliconangle.com', 'www.siliconangle.com']);
const unique = values => [...new Set(values.filter(Boolean))];
function fail(message, status = 404, code = 'NO_WEBSITE_TRANSCRIPT', details = {}) {
  throw Object.assign(new Error(message), { status, code, details });
}
function checkedUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { fail('Invalid publisher URL.', 400, 'INVALID_PUBLISHER_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || !HOSTS.has(url.hostname)) {
    fail('Use an HTTPS episode/transcript page from The Verge, Practical AI, Changelog, EE Times, W&B, DeepMind or theCUBE.',
      400, 'UNSUPPORTED_PUBLISHER');
  }
  url.hash = '';
  return url.href;
}
const clean = value => he.decode(String(value || '')).replace(/\u00a0/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
function nodeText($, node) {
  const copy = $(node).clone();
  copy.find('script, style, nav, form, button, aside').remove();
  copy.find('br').replaceWith('\n');
  copy.find('p, h1, h2, h3, h4, li, div').append('\n');
  return clean(copy.text());
}
function titleTokens(value) {
  return clean(value).normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/'s\b/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/)
    .filter(t => t && !new Set(['the', 'a', 'an', 'with', 'of', 'and', 'on', 'in', 'to', 'that', 'is', 'episode', 'podcast']).has(t));
}
function titlesMatch(expected, actual) {
  if (!expected) return true; // Explicitly supplied page; its title is shown for review.
  const a = unique(titleTokens(expected)), b = new Set(titleTokens(actual));
  const common = a.filter(t => b.has(t)).length;
  return a.length > 0 && (a.length <= 2 ? common === a.length : common / a.length >= 0.8);
}
function linkedUrls(markup, base) {
  const $ = cheerio.load(String(markup || ''));
  return unique($('a[href]').map((i, e) => {
    try { return new URL($(e).attr('href'), base).href; } catch { return ''; }
  }).get().concat((String(markup || '').match(/https:\/\/[^\s<>"']+/g) || []).map(u => he.decode(u))));
}
function videoUrl(value) {
  try {
    const u = new URL(value);
    const id = u.hostname === 'youtu.be' ? u.pathname.split('/')[1] :
      ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname) ?
        u.searchParams.get('v') || u.pathname.match(/^\/(?:embed|live)\/([\w-]{11})/)?.[1] : null;
    return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : '';
  } catch { return ''; }
}
function jsonArticles($) {
  const articles = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.articleBody === 'string') articles.push(value);
    if (Array.isArray(value)) value.forEach(walk);
    else if (value['@graph']) walk(value['@graph']);
  }
  $('script[type="application/ld+json"]').each((i, e) => {
    try { walk(JSON.parse($(e).text())); } catch { /* Bad metadata is not a transcript. */ }
  });
  return articles;
}
function extractTranscript(html, pageUrl, expectedTitle = '', { linkedTranscript = false } = {}) {
  const url = new URL(pageUrl), $ = cheerio.load(html);
  let title = clean($('h1').first().text() || $('meta[property="og:title"]').attr('content') || $('title').text());
  let transcript = '', boundaryVerified = false;
  if (/^(www\.)?theverge\.com$/.test(url.hostname)) {
    // Decoder's public structured article text includes its introduction and interview.
    const article = jsonArticles($).find(a => /welcome to decoder/i.test(a.articleBody));
    if (article) { title = clean(article.headline || title); transcript = clean(article.articleBody); }
    else transcript = nodeText($, $('article').first());
    // Require both interview boundaries. A description/paywall preview cannot pass.
    const start = transcript.search(/(?:^|\n)[^\n]{0,250}\bWelcome to Decoder\./i);
    const end = transcript.search(/Questions or comments\?/i);
    if (start >= 0 && end > start) {
      transcript = transcript.slice(start, end).trim(); boundaryVerified = true;
    } else transcript = '';
  } else if (['practicalai.show', 'practicalai.fm'].includes(url.hostname)) {
    title = clean($('.site-episode-title').first().text() || $('h2').first().text() || title);
    if (/\/transcript\/?$/.test(url.pathname) && $('body').hasClass('transcript')) {
      transcript = nodeText($, $('.site-episode-show-notes').first());
      boundaryVerified = !!transcript;
      title = title.replace(/^Transcript:\s*/i, '');
    }
  } else if (/^(www\.)?eetimes\.com$/.test(url.hostname)) {
    const body = $('.articleBody').first();
    const blocks = body.find('p, h2, h3').map((i, e) => clean($(e).text())).get();
    const start = blocks.findIndex(t => /FULL TRANSCRIPT AVAILABLE BELOW/i.test(t));
    if (start >= 0) {
      const end = blocks.findIndex((t, i) => i > start && /(?:see you next week|thanks for listening|thank you for listening|that.?s (?:it|all) for)/i.test(t));
      if (end > start) { transcript = blocks.slice(start + 1, end + 1).join('\n\n'); boundaryVerified = true; }
    }
  } else {
    // Additional sites work only when there is a clearly designated transcript block.
    const block = $('[data-transcript], #transcript, .episode-transcript, .podcast-transcript').first();
    if (block.length) { transcript = nodeText($, block); boundaryVerified = true; }
    if (!transcript && linkedTranscript) {
      const heading = $('h1, h2, h3').filter((i, e) => /^transcript\s*$/i.test($(e).text().trim())).first();
      const block = heading.nextUntil('h1, h2, h3');
      if (heading.length && block.length) { transcript = nodeText($, block); boundaryVerified = true; }
    }
  }
  if (!titlesMatch(expectedTitle, title)) fail('The publisher page title does not match the requested episode. Check the URL and exact title.',
    422, 'PUBLISHER_EPISODE_MISMATCH', { publisherPageTitle: title, publisherUrl: pageUrl });
  // Reject excerpts, empty shells, descriptions and suspiciously short sections.
  if (!boundaryVerified || /unlock (?:the |full )?transcript|view full transcript|transcript preview|subscribe to (?:read|view)/i.test(transcript) || transcript.split(/\s+/).length < 150) return { title, transcript: '' };
  return { title, transcript: clean(transcript) };
}

async function fetchPublisherTranscript({ episodeTitle = '', showName = '', showId = '',
  publisherUrls = [], publisherUrl = '', episodeNotes = '', source = '', fetchText,
  fetchYouTubeTranscript }) {
  const attempts = [], checked = new Set(), videoCandidates = new Set();
  const download = value => fetchText(checkedUrl(value), { allowedHosts: HOSTS });
  const queue = [];
  if (publisherUrl) queue.push({ url: checkedUrl(publisherUrl), explicit: true });
  // RSS item links/notes are episode-scoped. Never use the show's home-page video.
  for (const value of unique(publisherUrls.concat(linkedUrls(episodeNotes, 'https://invalid.example')))) {
    const video = videoUrl(value);
    if (video) videoCandidates.add(video);
    else { try { queue.push({ url: checkedUrl(value), explicit: false }); } catch { /* Unsupported source. */ } }
  }
  // Decoder often has no item link. Its official index can identify a recent interview.
  if (!publisherUrl && (showId === '1011668648' || /\bdecoder\b/i.test(showName))) {
    try {
      const indexUrl = 'https://www.theverge.com/decoder';
      const $ = cheerio.load(await download(indexUrl));
      const matches = unique($('a[href]').map((i, e) => {
        const href = $(e).attr('href');
        if (!/\/podcast\/\d+\//.test(href) || !titlesMatch(episodeTitle, $(e).text())) return '';
        try { return checkedUrl(href, indexUrl); } catch { return ''; }
      }).get());
      if (matches.length === 1) queue.unshift({ url: matches[0], explicit: false });
      else attempts.push({ url: indexUrl, status: matches.length ? 'ambiguous' : 'episode_not_in_index' });
    } catch (e) { attempts.push({ url: 'https://www.theverge.com/decoder', status: 'could_not_check', message: e.message }); }
  }
  for (let i = 0; i < queue.length && checked.size < 6; i++) {
    const entry = queue[i];
    if (checked.has(entry.url)) continue;
    checked.add(entry.url);
    try {
      const html = await download(entry.url);
      const found = extractTranscript(html, entry.url, episodeTitle, { linkedTranscript: entry.linked });
      if (found.transcript) return { ...found, source: source || entry.url, transcriptUrl: entry.url,
        transcriptSource: 'publisher-website', inputKind: 'transcript', retrievalChecks: attempts };
      const $ = cheerio.load(html);
      // Follow labelled transcript links, including Practical AI's separate transcript tab.
      $('a[href]').each((j, e) => {
        if (!/transcript/i.test($(e).text()) || /all.*transcripts/i.test($(e).text())) return;
        try { queue.push({ url: checkedUrl($(e).attr('href'), entry.url), explicit: entry.explicit, linked: true }); }
        catch { /* A publisher may link to an unsupported external service. */ }
      });
      // W&B sometimes prints its transcript short-link as plain show-note text.
      for (const match of html.matchAll(/(?:transcript and links|transcript and links\))[^\n]{0,100}?(https?:\/\/wandb\.me\/[^\s<"']+)/gi)) {
        queue.push({ url: checkedUrl(match[1].replace(/^http:/, 'https:')), explicit: entry.explicit, linked: true });
      }
      const videoLinks = unique($('a[href], iframe[src]').map((j, e) => videoUrl($(e).attr('href') || $(e).attr('src'))).get());
      // Only accept a single video on a verified episode page, never an archive.
      if (videoLinks.length === 1 && !['/the-podcast/', '/decoder', '/site/resources/podcast/'].includes(new URL(entry.url).pathname)) {
        videoCandidates.add(videoLinks[0]);
      }
      attempts.push({ url: entry.url, status: 'no_extractable_full_transcript' });
    } catch (e) {
      if (entry.explicit && e.code === 'PUBLISHER_EPISODE_MISMATCH') throw e;
      attempts.push({ url: entry.url, status: e.code === 'PUBLISHER_EPISODE_MISMATCH' ? 'wrong_episode' : 'could_not_check', message: e.message });
    }
  }
  if (videoCandidates.size === 1 && fetchYouTubeTranscript) {
    const youtubeUrl = [...videoCandidates][0];
    try {
      const transcript = await fetchYouTubeTranscript(youtubeUrl);
      if (!transcript.trim()) throw new Error('The linked video returned no captions.');
      return { transcript, title: episodeTitle || 'Linked podcast video', source: source || publisherUrl,
        transcriptUrl: youtubeUrl, transcriptSource: 'publisher-youtube-captions', inputKind: 'transcript', retrievalChecks: attempts };
    } catch (e) { attempts.push({ url: youtubeUrl, status: 'captions_unavailable', message: e.message }); }
  }
  const incomplete = attempts.some(a => ['could_not_check', 'captions_unavailable'].includes(a.status));
  fail(incomplete ? 'No transcript retrieved. Some publisher/caption checks failed; availability could not be confirmed. Try a direct transcript URL or paste the text.' :
    'No full transcript found in the checked RSS/website sources. Supply the publisher’s episode/transcript URL, try the matching YouTube video, or paste a transcript. This does not check Apple’s private transcripts.',
  incomplete ? 502 : 404, incomplete ? 'PUBLISHER_CHECK_INCOMPLETE' : 'NO_WEBSITE_TRANSCRIPT',
  { retrievalChecks: attempts, youtubeUrls: [...videoCandidates] });
}

module.exports = { fetchPublisherTranscript, extractTranscript, titlesMatch, checkedUrl, linkedUrls };
