const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, initDb, closeDb } = require('../app');

const testDatabase = path.join(__dirname, 'beta.test.db');

describe('Beta journal API', () => {
  beforeAll(async () => {
    fs.rmSync(testDatabase, { force: true });
    await initDb(testDatabase);
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(testDatabase, { force: true });
  });

  it('serves the small journal frontend', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Beta Journal');
  });

  it('creates a journal with a list of tags', async () => {
    const response = await request(app).post('/api/journals').send({
      title: 'SQLite migrations',
      content: 'A simple app needs a deliberate path for schema changes.',
      source: 'A podcast episode',
      tags: ['backend', 'sqlite', 'backend']
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ title: 'SQLite migrations', tags: ['backend', 'sqlite'] });
    expect(response.body.id).toEqual(expect.any(Number));
  });

  it('rejects tags that are not a list', async () => {
    const response = await request(app).post('/api/journals').send({
      title: 'Bad tags', content: 'A summary.', source: 'An article', tags: 'sqlite, backend'
    });
    expect(response.status).toBe(400);
  });

  it('searches, reads by ID, updates, and deletes a journal', async () => {
    const created = await request(app).post('/api/journals').send({
      title: 'Learning APIs', content: 'Use stable IDs for edits.', source: 'Personal note', tags: ['backend', 'express']
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
    expect(deleted.status).toBe(204);
    expect(missing.status).toBe(404);
  });

  it('analyzes content', async () => {
    const response = await request(app).post('/api/analyze').send({
      content: 'This is a long enough content string to trigger the AI analysis analysis analysis.'
    });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('title');
    expect(response.body).toHaveProperty('summary');
    expect(response.body).toHaveProperty('tags');
  });
});
