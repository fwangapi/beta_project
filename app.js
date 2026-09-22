//  require('dotenv').config();
// const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const OpenAI = require('openai');
const { YoutubeTranscript } = require('youtube-transcript');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The API works with a JavaScript list. SQLite stores it as JSON text.
function normaliseTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    throw new Error('tags must be a list of text values.');
  }
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function journalFromRow(row) {
  return { ...row, tags: JSON.parse(row.tags_json), tags_json: undefined };
}

async function createJournalTable() {
  await db.exec(`CREATE TABLE IF NOT EXISTS journals ( 
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    title TEXT NOT NULL, 
    content TEXT NOT NULL,         
    ai_summary TEXT,               -- 新增：AI 总结
    source TEXT NOT NULL, 
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, 
    tags_json TEXT NOT NULL DEFAULT '[]' 
  )`);
  
  // 极简迁移：如果旧表没有这个列，就加上
  try {
    await db.exec('ALTER TABLE journals ADD COLUMN ai_summary TEXT;');
  } catch (e) {
    // 如果列已存在，会报错，忽略即可
  }
}

// Earlier learning versions used source UNIQUE, date, and a comma-separated
// tag column. Rebuild only that old schema so existing notes remain usable.
async function migrateOldJournalTable() {
  const columns = await db.all('PRAGMA table_info(journals)');
  if (columns.length === 0 || columns.some((column) => column.name === 'tags_json')) return;

  const oldRows = await db.all('SELECT * FROM journals');
  await db.exec('BEGIN');
  try {
    await db.exec('ALTER TABLE journals RENAME TO journals_old');
    await createJournalTable();
    for (const row of oldRows) {
      const tags = typeof row.tag === 'string'
        ? row.tag.split(',').map((tag) => tag.trim()).filter(Boolean)
        : [];
      await db.run(
        `INSERT INTO journals (id, title, content, source, created_at, tags_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, row.title, row.content || '', row.source, row.date || new Date().toISOString(), JSON.stringify(tags)]
      );
    }
    await db.exec('DROP TABLE journals_old');
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

const initDb = async (filename = './beta.db') => {
  if (db) await db.close();
  db = await open({ filename, driver: sqlite3.Database });
  await createJournalTable();
  await migrateOldJournalTable();
  console.log('✅ Your database is successfully initialized!');
};

const closeDb = async () => {
  if (db) {
    await db.close();
    db = undefined;
  }
};

// GET a list of journals. ?search=sqlite uses the simple "%tag%" search.
app.get('/api/journals', async (req, res) => {
  try {
    const search = cleanText(req.query.search);
    const rows = search
      ? await db.all('SELECT * FROM journals WHERE tags_json LIKE ? ORDER BY created_at DESC, id DESC', [`%${search}%`])
      : await db.all('SELECT * FROM journals ORDER BY created_at DESC, id DESC');
    res.json(rows.map(journalFromRow));
  } catch (error) {
    res.status(500).json({ error: 'Could not load journals.' });
  }
});

// app.post('/api/analyze', async (req, res) => {
//   const { content } = req.body;
//   if (!content) return res.status(400).json({ error: 'Content is required.' });
//   // Mock AI response
//   res.json({
//     title: 'AI Generated Title',
//     summary: 'This is a mock summary of the provided content.',
//     tags: ['ai', 'mock', 'journal']
//   });
// });

// IDs are the stable internal link used by the frontend for edit and delete.
app.get('/api/journals/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM journals WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Journal not found.' });
    res.json(journalFromRow(row));
  } catch (error) {
    res.status(500).json({ error: 'Could not load this journal.' });
  }
});

app.post('/api/journals', async (req, res) => {
  const title = cleanText(req.body.title);
  const content = cleanText(req.body.content);
  const ai_summary = cleanText(req.body.ai_summary); // 新增
  const source = cleanText(req.body.source);
  let tags;
  try {
    tags = normaliseTags(req.body.tags);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (!title || !content || !source) {
    return res.status(400).json({ error: 'title, content, and source are required.' });
  }

  try {
    const result = await db.run(
      'INSERT INTO journals (title, content, ai_summary, source, tags_json) VALUES (?, ?, ?, ?, ?)',
        [title, content, ai_summary, source, JSON.stringify(tags)]
    );
    const row = await db.get('SELECT * FROM journals WHERE id = ?', [result.lastID]);
    res.status(201).json(journalFromRow(row));
  } catch (error) {
    res.status(500).json({ error: 'Could not save this journal.' });
  }
});

app.put('/api/journals/:id', async (req, res) => {
  const fields = [];
  const values = [];
  for (const name of ['title', 'content', 'source']) {
    if (req.body[name] !== undefined) {
      const value = cleanText(req.body[name]);
      if (!value) return res.status(400).json({ error: `${name} cannot be empty.` });
      fields.push(`${name} = ?`);
      values.push(value);
    }
  }
  if (req.body.tags !== undefined) {
    try {
      fields.push('tags_json = ?');
      values.push(JSON.stringify(normaliseTags(req.body.tags)));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  if (fields.length === 0) return res.status(400).json({ error: 'Provide at least one field to update.' });

  try {
    values.push(req.params.id);
    const result = await db.run(`UPDATE journals SET ${fields.join(', ')} WHERE id = ?`, values);
    if (result.changes === 0) return res.status(404).json({ error: 'Journal not found.' });
    const row = await db.get('SELECT * FROM journals WHERE id = ?', [req.params.id]);
    res.json(journalFromRow(row));
  } catch (error) {
    res.status(500).json({ error: 'Could not update this journal.' });
  }
});

app.delete('/api/journals/:id', async (req, res) => {
  try {
    const result = await db.run('DELETE FROM journals WHERE id = ?', [req.params.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Journal not found.' });
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: 'Could not delete this journal.' });
  }
});

// 🤖 AI 分析接口  gemini does not work - Google's specific IPv6 routing, use deepseek or qwen instead

// app.post('/api/analyze', async (req, res) => {
//   const { content } = req.body;
//   if (!content || content.length < 20) {
//     return res.status(400).json({ error: 'Content is too short.' });
//   }

//   if (!process.env.GEMINI_API_KEY) {
//     return res.json({
//       title: 'Mocked Analysis (Missing API Key)',
//       summary: 'Please add your GEMINI_API_KEY to your .env file to enable live summaries.',
//       tags: ['mock', 'setup']
//     });
//   }

//   try {
//     const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
//     // Use gemini-1.5-flash or gemini-1.5-flash
//     const model = genAI.getGenerativeModel({ 
//       model: 'gemini-2.5-flash-lite',
//       generationConfig: { responseMimeType: 'application/json' }
//     });

//     const prompt = `You are an expert technical analyst and summarizer. Analyze the provided transcript thoroughly.

// Provide:
// 1. A concise, accurate title.
// 2. A comprehensive, deeply detailed breakdown of every key topic and discussion point (covering technical hardware architecture, inference vs training, economics, and geopolitics).
// 3. A critical "Commentary on Validity" evaluating the claims made (categorized by strong/verified claims vs questionable/contested claims).
// 4. 4-7 relevant lowercase topic tags.

// Format the response as a strict JSON object:
// {
//   "title": "Clear, informative title",
//   "summary": "Full detailed markdown summary with headers (##), bullet points, and the validity commentary section",
//   "tags": ["tag1", "tag2", "tag3"]
// }

// Transcript:
// ${content}
// `;

//     const result = await model.generateContent(prompt);
//     const data = JSON.parse(result.response.text());

//     res.json(data);
//   } catch (error) {
//     console.error('Gemini Error:', error);
//     res.status(500).json({ error: 'AI analysis failed: ' + (error.message || error) });
//   }
// });

// 🎬 Fetch YouTube Transcript helper route
app.post('/api/transcript', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'YouTube URL is required.' });
  }

  try {
    // youtube-transcript automatically parses video IDs from standard URLs, shorts, and youtu.be links
    const transcriptItems = await YoutubeTranscript.fetchTranscript(url);

    if (!transcriptItems || transcriptItems.length === 0) {
      return res.status(404).json({ error: 'No captions found for this video.' });
    }

    // Join all transcript segments into a clean continuous text block
    const fullText = transcriptItems
      .map(item => item.text.replace(/&amp;#39;/g, "'").replace(/&quot;/g, '"'))
      .join(' ');

    res.json({ transcript: fullText });
  } catch (error) {
    console.error('Transcript fetch error:', error);
    res.status(500).json({ 
      error: 'Could not retrieve transcript. The video may lack captions or have them disabled.' 
    });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { content } = req.body;
  if (!content || content.length < 20) {
    return res.status(400).json({ error: 'Content is too short.' });
  }

  // Option A: DeepSeek
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: 'https://api.deepseek.com',
  });
  const modelName = 'deepseek-chat';

  /* 
  // Option B:  Qwen (Alibaba Cloud DashScope):
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  });
  const modelName = 'qwen-plus';
  */

  if (!apiKey) {
    return res.json({
      title: 'Mock Analysis (Missing API Key)',
      summary: 'Add your DEEPSEEK_API_KEY to .env to enable analysis.',
      tags: ['mock', 'setup']
    });
  }

  try {
    const prompt = `You are an expert technical analyst and summarizer. Analyze the provided transcript thoroughly.

Provide:
1. A concise, accurate title.
2. A comprehensive, deeply detailed breakdown of every key topic and discussion point (covering technical hardware architecture, inference vs training, economics, and geopolitics).
3. A critical "Commentary on Validity" evaluating the claims made (categorized by strong/verified claims vs questionable/contested claims).
4. 4-7 relevant lowercase topic tags.

Format the response as a strict JSON object:
{
  "title": "Clear, informative title",
  "summary": "Full detailed markdown summary with headers (##), bullet points, and the validity commentary section",
  "tags": ["tag1", "tag2", "tag3"]
}

Transcript:
${content}
`;

    const completion = await client.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    const data = JSON.parse(completion.choices[0].message.content);
    res.json(data);
  } catch (error) {
    console.error('Analysis Error:', error);
    res.status(500).json({ error: 'AI analysis failed: ' + (error.message || error) });
  }
});


module.exports = { app, initDb, closeDb };
