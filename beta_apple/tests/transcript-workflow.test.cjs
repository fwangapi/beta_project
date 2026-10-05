const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { fetchAppleRssTranscript } = require('../apple_rss');

const appleUrl = 'https://podcasts.apple.com/au/podcast/show/id123?i=456';
const feedUrl = 'https://publisher.example/feed.xml';
const transcriptUrl = 'https://publisher.example/transcript.vtt';
const transcript = 'The actual words spoken in this episode.\nA second sentence.';
const catalog = { results: [
  { feedUrl }, { trackId: 456, kind: 'podcast-episode', trackName: 'Test episode',
    episodeUrl: 'https://audio.example/specific-episode-file.mp3' }
] };
function feed(tag = '', title = 'Test episode', description = 'Description text') {
  return `<rss xmlns:p="https://podcastindex.org/namespace/1.0"><channel><language>en</language>
    <item><title>${title}</title><description>${description}</description>
    <enclosure url="https://audio.example/specific-episode-file.mp3"/>${tag}</item>
    </channel></rss>`;
}
const vtt = 'WEBVTT\n\n00:00.000 --> 00:03.000\nThe actual words spoken in this episode.\n\n00:03.000 --> 00:05.000\nA second sentence.';
function upstream(xml, data = catalog, extra = {}) {
  return async value => {
    const url = String(value);
    if (url.startsWith('https://itunes.apple.com/lookup')) return new Response(JSON.stringify(data));
    if (url === feedUrl) return new Response(xml);
    if (url === transcriptUrl) return new Response(extra.transcript || vtt, { status: extra.status || 200 });
    throw new Error(`Unexpected request ${url}`);
  };
}

test('RSS: show-level catalog, audio identity, namespace alias and VTT yield actual text', async () => {
  const previous = global.fetch;
  global.fetch = upstream(feed(`<p:transcript url="${transcriptUrl}" type="text/vtt"/>`, 'RSS title differs'));
  try {
    const result = await fetchAppleRssTranscript(appleUrl);
    assert.equal(result.transcript, transcript);
    assert.equal(result.title, 'RSS title differs');
    assert.equal(result.transcriptUrl, transcriptUrl);
    assert.equal(result.inputKind, 'transcript');
  } finally { global.fetch = previous; }
});

test('RSS: explicit fallback title overrides Apple title; description never becomes transcript', async () => {
  const previous = global.fetch;
  global.fetch = upstream(feed(`<p:transcript url="${transcriptUrl}" type="text/vtt"/>`, 'Fallback title'));
  try {
    const result = await fetchAppleRssTranscript(appleUrl, 'Fallback title', 'These notes are not spoken words.');
    assert.equal(result.transcript, transcript);
    assert.ok(!result.transcript.includes('These notes'));
  } finally { global.fetch = previous; }
});

test('RSS: matched episode without transcript is a precise unavailable result', async () => {
  const previous = global.fetch;
  global.fetch = upstream(feed());
  try {
    await assert.rejects(fetchAppleRssTranscript(appleUrl), error => {
      assert.equal(error.code, 'NO_WEBSITE_TRANSCRIPT');
      assert.equal(error.details.episodeTitle, 'Test episode');
      assert.match(error.message, /does not check/);
      return true;
    });
  } finally { global.fetch = previous; }
});

test('RSS: missing metadata requests a title and does not claim no transcript exists', async () => {
  const previous = global.fetch;
  global.fetch = upstream(feed(), { results: [{ feedUrl }] });
  try {
    await assert.rejects(fetchAppleRssTranscript(appleUrl), e => e.code === 'NEEDS_TITLE');
  } finally { global.fetch = previous; }
});

test('RSS: network errors are could-not-check results, not transcript absence', async () => {
  const previous = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    await assert.rejects(fetchAppleRssTranscript(appleUrl), e => e.code === 'UPSTREAM_ERROR' && e.status === 502);
  } finally { global.fetch = previous; }
});

test('RSS: duplicate titles never silently select an episode', async () => {
  const previous = global.fetch;
  const xml = feed().replace('</channel>', '<item><title>Test episode</title></item></channel>');
  global.fetch = upstream(xml);
  try {
    await assert.rejects(fetchAppleRssTranscript(appleUrl, 'Test episode'), e => e.code === 'AMBIGUOUS_EPISODE');
  } finally { global.fetch = previous; }
});

test('RSS: empty transcript and unsupported format cannot masquerade as success', async () => {
  const previous = global.fetch;
  try {
    global.fetch = upstream(feed(`<p:transcript url="${transcriptUrl}" type="text/vtt"/>`), catalog,
      { transcript: 'WEBVTT\n\nNOTE no speech' });
    await assert.rejects(fetchAppleRssTranscript(appleUrl), e => e.code === 'NO_WEBSITE_TRANSCRIPT');
    global.fetch = upstream(feed(`<p:transcript url="${transcriptUrl}" type="text/html"/>`));
    await assert.rejects(fetchAppleRssTranscript(appleUrl), e => e.code === 'NO_WEBSITE_TRANSCRIPT');
  } finally { global.fetch = previous; }
});

test('RSS: plain text and Podcasting 2.0 JSON segments preserve source text', async () => {
  const previous = global.fetch;
  try {
    for (const [type, raw, expected] of [
      ['text/plain', 'Actual text &amp; words.', 'Actual text & words.'],
      ['application/json', JSON.stringify({ segments: [{ text: 'One.' }, { text: 'Two.' }] }), 'One.\nTwo.']
    ]) {
      global.fetch = upstream(feed(`<p:transcript url="${transcriptUrl}" type="${type}"/>`), catalog, { transcript: raw });
      assert.equal((await fetchAppleRssTranscript(appleUrl)).transcript, expected);
    }
  } finally { global.fetch = previous; }
});

// A fake AI completion verifies the prompt/input path without spending tokens.
let completionRequest;
require.cache[require.resolve('openai')] = { exports: class {
  constructor() { this.chat = { completions: { create: async options => {
    completionRequest = options;
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      title: 'Notes title', summary: 'A short summary of the supplied notes.', tags: ['notes']
    }) } }] };
  } } }; }
} };
const { app, initDb, closeDb } = require('../app');
let server;
let base;
const nativeFetch = global.fetch;
async function api(path, body, password) {
  const response = await nativeFetch(base + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(password ? { 'x-access-code': password } : {}) },
    body: JSON.stringify(body)
  } : {});
  return { status: response.status, data: await response.json() };
}
test('API: migration and save/reload preserve notes, transcript provenance and analysis snapshot', async () => {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const databasePath = `/tmp/beta-workflow-${process.pid}.db`;
  const old = await open({ filename: databasePath, driver: sqlite3.Database });
  await old.exec(`CREATE TABLE journals (
    id INTEGER PRIMARY KEY, title TEXT, ai_summary TEXT, thoughts TEXT, source TEXT, created_at TEXT,
    tags_json TEXT, transcript TEXT, transcript_source TEXT
  ); INSERT INTO journals VALUES (1, 'Old summary', 'Older notes summary', '', '${appleUrl}',
    '2026-01-01', '[]', 'Only some episode notes.', 'apple_podcast');`);
  await old.close();
  await initDb(databasePath);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const oldEntry = (await api('/api/journals/1')).data;
  assert.equal(oldEntry.input_kind, 'unknown');
  assert.equal(oldEntry.analysis_input, '');
  assert.equal(oldEntry.transcript, 'Only some episode notes.');
  const body = { title: 'New', ai_summary: 'Summary', source: appleUrl, transcript,
    transcript_source: 'apple_podcast', input_kind: 'transcript', transcript_url: transcriptUrl,
    analysis_input: transcript, analysis_input_kind: 'transcript', analysis_basis: 'Supplied transcript only.' };
  const saved = await api('/api/journals', body);
  assert.equal(saved.status, 201);
  const loaded = (await api(`/api/journals/${saved.data.id}`)).data;
  for (const field of Object.keys(body)) assert.equal(loaded[field], body[field]);
  const updated = await nativeFetch(`${base}/api/journals/${saved.data.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: 'Edited source text', input_kind: 'episode_notes' })
  });
  assert.equal(updated.status, 200);
  assert.equal((await api(`/api/journals/${saved.data.id}`)).data.analysis_input, transcript);
  assert.equal((await api('/api/journals', { ...body, input_kind: 'invented' })).status, 400);
  // Publisher retrieval stays independent of DeepSeek/password and saves real source text.
  const previousFetch = global.fetch;
  const publisherUrl = 'https://practicalai.show/339/transcript';
  try {
    global.fetch = async () => new Response('<body class="transcript"><h2 class="site-episode-title">Test episode</h2>' +
      '<div class="site-episode-show-notes"><p>Daniel: ' + 'Actual fictional speech for this test. '.repeat(35) + '</p></div></body>');
    const retrieved = await api('/api/transcript/apple', { publisherUrl });
    assert.equal(retrieved.status, 200);
    assert.equal(retrieved.data.transcriptSource, 'publisher-website');
    assert.equal(retrieved.data.transcriptUrl, publisherUrl);
    assert.equal(completionRequest, undefined);
    const websiteSaved = await api('/api/journals', { title: 'Publisher transcript', ai_summary: 'User-reviewed summary.', source: publisherUrl,
      transcript: retrieved.data.transcript, transcript_source: 'apple_podcast',
      input_kind: 'transcript', transcript_url: publisherUrl });
    assert.equal(websiteSaved.status, 201);
    assert.equal((await api(`/api/journals/${websiteSaved.data.id}`)).data.transcript, retrieved.data.transcript);
  } finally { global.fetch = previousFetch; }
  process.env.APP_PASSWORD = 'test-password';
  process.env.DEEPSEEK_API_KEY = 'fake-key-never-sent';
  assert.equal((await api('/api/analyze', { content: 'A sufficiently long input.' })).status, 401);
  const notes = 'Episode title: Example\nDescription: A short introduction to the topic.';
  const analysis = await api('/api/analyze', { content: notes, input_kind: 'episode_notes' }, 'test-password');
  assert.equal(analysis.status, 200);
  assert.match(analysis.data.analysis_basis, /full episode transcript was not used/);
  assert.match(analysis.data.summary, /Summary basis/);
  assert.match(completionRequest.messages[0].content, /Never invent missing episode details/);
  assert.ok(completionRequest.messages[0].content.includes(notes));
  assert.equal(completionRequest.tools, undefined);
  await server.close(); server = null;
  await closeDb();
  await initDb(databasePath); // Verify migration is idempotent.
  await closeDb();
  fs.unlinkSync(databasePath);
});

const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function ui() {
  const requests = [];
  let appleResponse = { status: 200, body: { transcript, title: 'Test episode', source: appleUrl, transcriptUrl } };
  const dom = new JSDOM(fs.readFileSync(require.resolve('../public/index.html'), 'utf8'), {
    url: 'http://localhost:3001', runScripts: 'dangerously', beforeParse(window) {
      window.AbortController = AbortController;
      window.fetch = async (path, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        requests.push({ path, body });
        if (path.startsWith('/api/journals?')) return new Response('[]');
        if (path === '/api/transcript/apple') return new Response(JSON.stringify(appleResponse.body), { status: appleResponse.status });
        if (path === '/api/transcript') return new Response(JSON.stringify({ transcript: 'Actual YouTube captions for this video.' }));
        if (path === '/api/analyze') return new Response(JSON.stringify({ title: 'Summary title', summary: 'Summary text',
          tags: ['test'], analysis_basis: body.input_kind === 'episode_notes' ? 'Notes only. No transcript or web search.' : 'Supplied transcript only.' }));
        if (path === '/api/journals') return new Response(JSON.stringify({ id: 1, ...body }), { status: 201 });
        throw new Error(`Unexpected frontend request ${path}`);
      };
    }
  });
  await tick();
  return { dom, requests, el: id => dom.window.document.getElementById(id),
    response: value => { appleResponse = value; } };
}

test('UI: podcast success shows read-only transcript and saves the exact analyzed input', async () => {
  const u = await ui();
  try {
    u.el('apple-url').value = appleUrl;
    u.el('apple-fetch-btn').click(); await tick();
    assert.equal(u.el('apple-transcript').value, transcript);
    assert.equal(u.el('apple-transcript').readOnly, true);
    assert.equal(u.el('manual-input-panel').classList.contains('hidden'), true);
    u.el('ai-analyze').click(); await tick();
    const analysis = u.requests.find(r => r.path === '/api/analyze');
    assert.deepEqual(analysis.body, { content: transcript, input_kind: 'transcript' });
    u.el('journal-form').dispatchEvent(new u.dom.window.Event('submit', { cancelable: true })); await tick();
    const saved = u.requests.find(r => r.path === '/api/journals');
    assert.equal(saved.body.transcript, transcript);
    assert.equal(saved.body.transcript_url, transcriptUrl);
    assert.equal(saved.body.analysis_input, transcript);
  } finally { u.dom.window.close(); }
});

test('UI: failed retry clears old podcast text; notes fallback is explicit and never calls AI automatically', async () => {
  const u = await ui();
  try {
    u.el('apple-url').value = appleUrl;
    u.el('apple-fetch-btn').click(); await tick();
    u.response({ status: 404, body: { error: 'No publisher transcript link.', code: 'NO_PUBLISHER_TRANSCRIPT', episodeTitle: 'Test episode' } });
    u.el('apple-fetch-btn').click(); await tick();
    assert.equal(u.el('transcript').value, '');
    assert.equal(u.el('apple-transcript').value, '');
    assert.match(u.el('apple-status').textContent, /No podcast transcript was loaded/);
    u.el('apple-description').value = 'These are only the short episode description notes.';
    u.el('apple-notes-btn').click(); await tick();
    assert.equal(u.el('input-kind').value, 'episode_notes');
    assert.equal(u.el('transcript-source').value, 'manual');
    assert.equal(u.requests.filter(r => r.path === '/api/analyze').length, 0);
    u.el('ai-analyze').click(); await tick();
    assert.equal(u.requests.find(r => r.path === '/api/analyze').body.input_kind, 'episode_notes');
    assert.match(u.el('ai-status').textContent, /full podcast transcript was not used/);
    u.el('transcript').value += '\nA later manual edit.';
    u.el('transcript').dispatchEvent(new u.dom.window.Event('input'));
    assert.match(u.el('analysis-basis').textContent, /Text changed after analysis/);
  } finally { u.dom.window.close(); }
});

test('UI: YouTube and manual paste retain the existing separate fetch/analyze procedure', async () => {
  const u = await ui();
  try {
    u.el('yt-url').value = 'https://youtu.be/abcdefghijk';
    u.el('yt-fetch-btn').click(); await tick();
    assert.equal(u.el('transcript-source').value, 'youtube');
    assert.equal(u.el('input-kind').value, 'transcript');
    assert.equal(u.el('manual-input-panel').classList.contains('hidden'), false);
    assert.equal(u.requests.filter(r => r.path === '/api/analyze').length, 0);
    u.el('transcript').value = 'An article pasted by the user for analysis.';
    u.el('transcript').dispatchEvent(new u.dom.window.Event('input'));
    assert.equal(u.el('transcript-source').value, 'manual');
    u.el('input-kind').value = 'article';
    u.el('ai-analyze').click(); await tick();
    assert.equal(u.requests.find(r => r.path === '/api/analyze').body.input_kind, 'article');
  } finally { u.dom.window.close(); }
});


test('UI: publisher URL alone is submitted and changing it invalidates the retrieved transcript', async () => {
  const u = await ui();
  try {
    const url = 'https://practicalai.show/339/transcript';
    u.el('publisher-url').value = url;
    u.el('apple-fetch-btn').click(); await tick();
    const request = u.requests.find(r => r.path === '/api/transcript/apple');
    assert.equal(request.body.url, '');
    assert.equal(request.body.publisherUrl, url);
    assert.equal(u.el('apple-transcript').value, transcript);
    assert.equal(u.requests.filter(r => r.path === '/api/analyze').length, 0);
    u.el('publisher-url').value = 'https://practicalai.show/340/transcript';
    u.el('publisher-url').dispatchEvent(new u.dom.window.Event('input'));
    assert.equal(u.el('transcript').value, '');
    assert.equal(u.el('apple-transcript').value, '');
  } finally { u.dom.window.close(); }
});

after(async () => { if (server) await server.close(); await closeDb(); });
