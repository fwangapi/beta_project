const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractTranscript, fetchPublisherTranscript, checkedUrl } = require('../publisher_transcript');
const { fetchAppleRssTranscript } = require('../apple_rss');
const words = 'These are the actual spoken words used as a fictional transcript for testing. '.repeat(25);
const title = 'The SaaSpocalypse that wasn’t, with Atlassian CEO Mike Cannon-Brookes';
const expectedTitle = "The SaaSpocalypse that wasn't, with Atlassian's CEO";
const articleUrl = 'https://www.theverge.com/podcast/1000914/example';
function verge(end = true, headline = title) {
  return `<html><h1>${headline}</h1><p>NOT TRANSCRIPT: description only.</p>
    <script type="application/ld+json">${JSON.stringify({ headline,
    articleBody: `Intro excluded.\nMike Cannon-Brookes. Welcome to Decoder.\n${words}\nThank you for having me.\n${end ? 'Questions or comments? Contact the show.' : ''}` })}</script></html>`;
}
const practical = `<html><body class="transcript"><h1>Practical AI</h1><h2 class="site-episode-title">Test episode</h2>
  <nav>NOT TRANSCRIPT NAVIGATION</nav><div class="site-episode-show-notes"><p>Daniel: ${words}</p><p>Chris: Goodbye.</p></div></body></html>`;

test('Decoder extraction requires interview boundaries and excludes introduction and navigation', () => {
  const r = extractTranscript(verge(), articleUrl, expectedTitle);
  assert.ok(r.transcript.startsWith('Mike Cannon-Brookes. Welcome to Decoder.'));
  assert.ok(r.transcript.endsWith('Thank you for having me.'));
  assert.ok(!r.transcript.includes('Intro excluded'));
  assert.ok(!r.transcript.includes('NOT TRANSCRIPT'));
  assert.equal(extractTranscript(verge(false), articleUrl, expectedTitle).transcript, '');
});
test('Wrong episode cannot pass just because its page contains transcript text', () => {
  assert.throws(() => extractTranscript(verge(true, 'A different guest and topic'), articleUrl, expectedTitle),
    e => e.code === 'PUBLISHER_EPISODE_MISMATCH');
});
test('Practical AI extraction takes only the transcript content and correct episode title', () => {
  const r = extractTranscript(practical, 'https://practicalai.show/339/transcript', 'Test episode');
  assert.equal(r.title, 'Test episode');
  assert.ok(r.transcript.includes('Daniel:'));
  assert.ok(!r.transcript.includes('NAVIGATION'));
  assert.equal(extractTranscript(practical.replace('class="transcript"', ''), 'https://practicalai.show/339/transcript').transcript, '');
});
test('EE Times requires the full-transcript marker and closing, not show notes', () => {
  const url = 'https://www.eetimes.com/podcasts/example/';
  const html = `<h1>Test episode</h1><div class="articleBody"><p>NOT TRANSCRIPT description</p>
    <p>[FULL TRANSCRIPT AVAILABLE BELOW]</p><p>HOST: ${words}</p><p>See you next week.</p><p>UNRELATED FOOTER</p></div>`;
  const r = extractTranscript(html, url, 'Test episode');
  assert.ok(r.transcript.startsWith('HOST:'));
  assert.ok(!r.transcript.includes('NOT TRANSCRIPT') && !r.transcript.includes('UNRELATED'));
  assert.equal(extractTranscript(html.replace('[FULL TRANSCRIPT AVAILABLE BELOW]', 'Show notes'), url).transcript, '');
});
test('Publisher URL rejects private, unrelated and misleading hosts before downloading', () => {
  for (const url of ['http://www.theverge.com/podcast/123/x', 'https://127.0.0.1/',
    'https://www.theverge.com.evil.example/', 'https://user:pass@www.theverge.com/', 'https://www.theverge.com:444/']) {
    assert.throws(() => checkedUrl(url));
  }
});
test('Decoder RSS without transcript can find a uniquely matching official index article', async () => {
  const calls = [];
  const r = await fetchPublisherTranscript({ showId: '1011668648', episodeTitle: expectedTitle,
    fetchText: async url => {
      calls.push(url);
      if (url.endsWith('/decoder')) return `<a href="/podcast/1000914/example">${title}</a>`;
      if (url === articleUrl) return verge();
      throw new Error('Unexpected URL');
    } });
  assert.equal(r.transcriptSource, 'publisher-website');
  assert.equal(r.transcriptUrl, articleUrl);
  assert.equal(calls.length, 2);
});
test('Practical AI follows the episode transcript tab without treating description as transcript', async () => {
  const r = await fetchPublisherTranscript({ episodeTitle: 'Test episode', publisherUrls: ['https://practicalai.show/339'],
    fetchText: async url => url.endsWith('/transcript') ? practical :
      '<h2 class="site-episode-title">Test episode</h2><p>Only notes here.</p><a href="/339/transcript">Transcript</a>' });
  assert.equal(r.transcriptUrl, 'https://practicalai.show/339/transcript');
  assert.ok(!r.transcript.includes('Only notes'));
});
test('Network failure is inconclusive; available description is never returned as transcript', async () => {
  await assert.rejects(fetchPublisherTranscript({ publisherUrl: articleUrl, fetchText: async () => { throw new Error('offline'); } }),
    e => e.code === 'PUBLISHER_CHECK_INCOMPLETE' && e.status === 502);
  await assert.rejects(fetchPublisherTranscript({ publisherUrl: articleUrl,
    fetchText: async () => '<h1>Episode</h1><p>This is just the episode description.</p>' }),
    e => e.code === 'NO_WEBSITE_TRANSCRIPT');
});
test('Only an episode-scoped, unambiguous video can trigger existing YouTube captions', async () => {
  const videos = [];
  const r = await fetchPublisherTranscript({ episodeTitle: 'Test episode', episodeNotes:
    '<a href="https://www.youtube.com/watch?v=abcdefghijk">Watch this episode</a>',
    fetchText: async () => { throw new Error('No website fetch expected'); },
    fetchYouTubeTranscript: async url => { videos.push(url); return words; } });
  assert.equal(r.transcriptSource, 'publisher-youtube-captions');
  assert.equal(videos.length, 1);
  await assert.rejects(fetchPublisherTranscript({ episodeNotes: '<a href="https://www.youtube.com/playlist?list=XYZ">Archive</a>',
    fetchText: async () => '', fetchYouTubeTranscript: async () => { throw new Error('Must not run'); } }),
    e => e.code === 'NO_WEBSITE_TRANSCRIPT');
});
test('Direct publisher URL works without an Apple link, and redirect to an unrelated host is refused', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => new Response(verge());
    const r = await fetchAppleRssTranscript('', '', '', { publisherUrl: articleUrl });
    assert.equal(r.source, articleUrl);
    assert.equal(r.transcriptUrl, articleUrl);
    const calls = [];
    global.fetch = async url => { calls.push(String(url)); return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/' } }); };
    await assert.rejects(fetchAppleRssTranscript('', '', '', { publisherUrl: articleUrl }), e => e.code === 'PUBLISHER_CHECK_INCOMPLETE');
    assert.equal(calls.length, 1);
  } finally { global.fetch = original; }
});
