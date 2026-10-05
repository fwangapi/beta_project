const fs = require('fs');
const path = require('path');
const request = require('supertest');
const transcriptLibrary = require('youtube-transcript');
const { app, initDb, closeDb, parseModelJson } = require('../app');

const testDatabase = path.join(__dirname, 'beta.test.db');
const migrationDatabase = path.join(__dirname, 'beta.migration.test.db');

describe('Beta journal API', () => {
  beforeAll(async () => {
    fs.rmSync(testDatabase, { force: true });
    await initDb(testDatabase);
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(testDatabase, { force: true });
    fs.rmSync(migrationDatabase, { force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses a valid AI JSON object even when the provider appends trailing text', () => {
    const result = parseModelJson('```json\n{"title":"A {test}","summary":"Summary","tags":["ai"]}\nDone.\n```');
    expect(result).toEqual({ title: 'A {test}', summary: 'Summary', tags: ['ai'] });
  });

  it('reports incomplete or malformed AI JSON clearly', () => {
    expect(() => parseModelJson('{"title":"incomplete"')).toThrow(/incomplete JSON object/i);
    expect(() => parseModelJson('{"title":}')).toThrow(/invalid JSON/i);
  });

  it('serves the small journal frontend', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Beta Journal');
    expect(response.text).toContain('id="transcript"');
    expect(response.text).toContain('id="transcript-entry-id"');
    expect(response.text).toContain('id="retrieve-transcript"');
    expect(response.text).toContain('id="retrieved-transcript"');
    expect(response.text).not.toContain('apple-fetch-btn');
  });

  it('fetches English captions from YouTube', async () => {
    const fetchTranscript = jest.spyOn(transcriptLibrary, 'fetchTranscript')
      .mockResolvedValue([{ text: 'English caption text', duration: 2, offset: 0, lang: 'en' }]);
    const response = await request(app).post('/api/transcript').send({
      url: 'https://www.youtube.com/watch?v=abcdefghijk'
    });

    expect(fetchTranscript).toHaveBeenCalledWith('abcdefghijk', { lang: 'en' });
    expect(response.status).toBe(200);
    expect(response.body.transcript).toBe('English caption text');
  });

  it('explains when English captions are unavailable', async () => {
    const fetchTranscript = jest.spyOn(transcriptLibrary, 'fetchTranscript')
      .mockRejectedValue(Object.assign(new Error('English captions unavailable.'), {
        name: 'YoutubeTranscriptNotAvailableLanguageError'
      }));
    const response = await request(app).post('/api/transcript').send({
      url: 'https://www.youtube.com/watch?v=abcdefghijk'
    });
    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/English captions are not available/i);
    expect(response.body.error).toMatch(/English captions are not available/i);
  });

  it('does not expose the removed Apple transcript endpoint', async () => {
    const response = await request(app).post('/api/transcript/apple').send({
      url: 'https://podcasts.apple.com/example'
    });
    expect(response.status).toBe(404);
  });

  it('creates a journal with a list of tags', async () => {
    const response = await request(app).post('/api/journals').send({
      title: 'SQLite migrations',
      ai_summary: 'A simple app needs a deliberate path for schema changes.',
      thoughts: 'I should plan database migrations early.',
      transcript: 'The complete source transcript is saved separately.',
      transcript_source: 'youtube',
      source: 'A YouTube video',
      tags: ['backend', 'sqlite', 'backend']
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      title: 'SQLite migrations',
      ai_summary: 'A simple app needs a deliberate path for schema changes.',
      thoughts: 'I should plan database migrations early.',
      transcript: 'The complete source transcript is saved separately.',
      transcript_source: 'youtube',
      tags: ['backend', 'sqlite']
    });
    expect(response.body.id).toEqual(expect.any(Number));
  });

  it('stores AI summaries and human thoughts when creating or updating a journal', async () => {
    const created = await request(app).post('/api/journals').send({
      title: 'AI summary persistence',
      ai_summary: 'A concise summary generated from the transcript.',
      thoughts: 'My initial reflections.',
      transcript: 'Original source transcript text.',
      transcript_source: 'youtube',
      input_kind: 'transcript',
      analysis_input: 'Original source transcript text.',
      analysis_input_kind: 'transcript',
      analysis_basis: 'Based only on the supplied transcript text.',
      source: 'A video',
      tags: ['ai']
    });

    expect(created.status).toBe(201);
    expect(created.body.ai_summary).toBe('A concise summary generated from the transcript.');
    expect(created.body.thoughts).toBe('My initial reflections.');
    expect(created.body.transcript).toBe('Original source transcript text.');
    expect(created.body.transcript_source).toBe('youtube');
    expect(created.body.input_kind).toBe('transcript');
    expect(created.body.analysis_input).toBe('Original source transcript text.');
    expect(created.body.analysis_input_kind).toBe('transcript');
    expect(created.body.analysis_basis).toBe('Based only on the supplied transcript text.');

    const updated = await request(app).put(`/api/journals/${created.body.id}`).send({
      ai_summary: 'An edited AI summary.',
      thoughts: 'My edited reflections.',
      transcript: 'Updated transcript text.',
      transcript_source: 'apple_podcast'
    });

    expect(updated.status).toBe(200);
    expect(updated.body.ai_summary).toBe('An edited AI summary.');
    expect(updated.body.thoughts).toBe('My edited reflections.');
    expect(updated.body.transcript).toBe('Updated transcript text.');
    expect(updated.body.transcript_source).toBe('apple_podcast');
    expect(updated.body.analysis_input).toBe('Original source transcript text.');
    expect(updated.body.analysis_input_kind).toBe('transcript');
  });

  it('rejects unsupported transcript source values', async () => {
    const response = await request(app).post('/api/journals').send({
      title: 'Bad transcript source',
      ai_summary: 'A summary.',
      source: 'A source',
      transcript_source: 'unknown'
    });
    expect(response.status).toBe(400);

    const appleSource = await request(app).post('/api/journals').send({
      title: 'Apple-era source',
      ai_summary: 'A summary.',
      source: 'An archived source',
      transcript_source: 'apple_podcast'
    });
    expect(appleSource.status).toBe(400);
  });

  it('rejects tags that are not a list', async () => {
    const response = await request(app).post('/api/journals').send({
      title: 'Bad tags', ai_summary: 'A summary.', source: 'An article', tags: 'sqlite, backend'
    });
    expect(response.status).toBe(400);
  });

  it('searches, reads by ID, updates, and deletes a journal', async () => {
    const created = await request(app).post('/api/journals').send({
      title: 'Learning APIs',
      ai_summary: 'Use stable IDs for edits.',
      source: 'Personal note',
      transcript: 'Saved transcript to retrieve by journal number.',
      transcript_source: 'youtube',
      tags: ['backend', 'express']
    });
    const id = created.body.id;

    const searched = await request(app).get('/api/journals?search=express');
    const updated = await request(app).put(`/api/journals/${id}`).send({ tags: ['backend', 'testing'] });
    const found = await request(app).get(`/api/journals/${id}`);
    const deleted = await request(app).delete(`/api/journals/${id}`);
    const missing = await request(app).get(`/api/journals/${id}`);

    expect(searched.body.some((entry) => entry.id === id)).toBe(true);
    expect(updated.status).toBe(200);
    expect(found.body.tags).toEqual(['backend', 'testing']);
    expect(found.body.transcript).toBe('Saved transcript to retrieve by journal number.');
    expect(deleted.status).toBe(204);
    expect(missing.status).toBe(404);
  });

  it('requires authentication before analyzing content', async () => {
    const response = await request(app).post('/api/analyze').send({
      content: 'This is a long enough content string to trigger the AI analysis analysis analysis.'
    });
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/password/i);
  });

  it('migrates the old content and ai_summary columns without duplicating summaries as thoughts', async () => {
    const sqlite = new (require('sqlite3').Database)(migrationDatabase);
    await new Promise((resolve, reject) => {
      sqlite.serialize(() => {
        sqlite.run(`CREATE TABLE journals (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          ai_summary TEXT,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]'
        )`);
        sqlite.run(
          `INSERT INTO journals (id, title, content, ai_summary, source, created_at, tags_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [42, 'Existing entry', 'Saved AI summary', 'Saved AI summary', 'A video', '2026-09-28', '[]']
        );
        sqlite.close((error) => error ? reject(error) : resolve());
      });
    });

    await initDb(migrationDatabase);
    const response = await request(app).get('/api/journals/42');

    expect(response.status).toBe(200);
    expect(response.body.ai_summary).toBe('Saved AI summary');
    expect(response.body.thoughts).toBe('');
    expect(response.body.transcript).toBe('');
    expect(response.body.transcript_source).toBe('manual');
    expect(response.body.input_kind).toBe('unknown');
    expect(response.body.transcript_url).toBe('');
    expect(response.body.analysis_input).toBe('');
    expect(response.body.analysis_input_kind).toBe('unknown');
    expect(response.body.analysis_basis).toBe('');
    expect(response.body).not.toHaveProperty('content');
  });
});
