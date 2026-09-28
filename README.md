# Beta Journal

Beta Journal is a small local web app for turning YouTube videos or pasted
transcripts into searchable journal entries. It can fetch a video's captions,
ask DeepSeek for a title, summary, and tags, and save the AI summary separately
from your personal thoughts.

The app is designed to run on your own computer. The browser UI, Node.js server,
and SQLite database are local; AI analysis is sent from the server to DeepSeek.
YouTube transcript fetching uses an unofficial interface and can be blocked or
rate-limited by YouTube.

## Project map

```text
beta/
├── app.js                  Express app, API routes, DeepSeek integration,
│                           transcript fetching, SQLite setup and migrations
├── beta_digest.py          Email unsent journal entries using Gamma's Gmail settings
├── index.js                Server entry point used by npm start / npm run dev
├── public/
│   └── index.html          Single-page frontend: form, browser logic and styles
├── tests/
│   └── test_beta_digest.py Python tests for digest rendering and delivery state
├── __tests__/
│   └── api.test.js         API, persistence and database migration tests
├── check-models.js         Older Gemini model-listing helper; not used by app
├── package.json            Dependencies and npm scripts
├── package-lock.json       Exact dependency resolution for npm ci
├── .gitignore              Excludes credentials, local databases and artifacts
├── .env                    Local secrets; create this yourself, never commit it
└── beta.db                 Local SQLite data; created on first run, not committed
```

## How a journal entry is created

1. Open the app and paste a transcript/article, or enter a YouTube URL and
   choose **Fetch Transcript**.
2. Choose **Suggest Title, Summary & Tags**. The browser sends the transcript
   to the server's `/api/analyze` endpoint; the server calls DeepSeek and
   returns a title, summary, and tags.
3. Review or edit the generated **AI Summary** and add optional **My thoughts**.
4. Choose **Save entry**. The server writes the journal fields to SQLite.
5. The page loads saved entries from `/api/journals`; each entry can be edited,
   deleted, or found by searching its tags.

The raw transcript is used for analysis but is not saved as a journal field.
The AI summary and human thoughts are stored independently.

## Database

SQLite creates a `journals` table in `beta.db` by default. Set `DATABASE_PATH`
to use a different file. The database is local to the machine unless you
manually move it.

```text
journals
├── id          INTEGER  Primary key, assigned by SQLite
├── title       TEXT     Entry title
├── ai_summary  TEXT     Generated summary; editable in the web form
├── thoughts    TEXT     Optional personal notes; editable separately
├── source      TEXT     Video URL or other source description
├── created_at  TEXT     Creation timestamp, defaults to SQLite current time
└── tags_json   TEXT     Tags stored as JSON text, e.g. ["ai", "hardware"]

beta_digest_deliveries
├── journal_id  INTEGER  Journal entry ID, primary key
├── sent_at     TEXT     Time sent or baselined
└── status      TEXT     "sent" after email, or "baseline" for pre-existing rows
```

The API converts `tags_json` to a `tags` array for the frontend. Startup runs
schema migrations so older databases can be upgraded while preserving entry
IDs, summaries, tags, and timestamps. Newer schema versions use `ai_summary`
for the former `content` column and `thoughts` for the former `ai_summary`
column. When migrating rows created during the earlier duplicate-backfill
period, identical summary values are kept as `ai_summary` and not copied into
`thoughts`.

Back up the database before experimenting with migrations. To transfer entries
to another computer, stop the app and copy `beta.db` privately; do not commit
the database or synchronize it while the app is writing to it.

## Backend API

The Express server serves `public/` and provides these JSON endpoints:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/journals` | List entries; optional `?search=tag` searches tags |
| `GET` | `/api/journals/:id` | Read one entry |
| `POST` | `/api/journals` | Create an entry |
| `PUT` | `/api/journals/:id` | Update supplied entry fields |
| `DELETE` | `/api/journals/:id` | Delete an entry |
| `POST` | `/api/transcript` | Fetch YouTube captions from a URL or video ID |
| `POST` | `/api/analyze` | Generate title, summary, and tags with DeepSeek |

`APP_PASSWORD` is required for AI analysis. The browser asks for it when first
calling the protected analysis endpoint and keeps it in memory for that page
session. Transcript fetching and journal CRUD are not password-protected in the
current implementation; keep this app on a trusted local machine/network.
`DEEPSEEK_API_KEY` is only read by the server and must never be put in the
frontend.

## Requirements and local setup

- Node.js 18 or newer
- A DeepSeek API key for AI analysis
- An application password for AI analysis

Install the locked dependencies:

```sh
npm ci
```

Create `.env` in the project root:

```dotenv
APP_PASSWORD=choose-a-private-password
DEEPSEEK_API_KEY=your-deepseek-api-key
# Optional; defaults to deepseek-chat
# DEEPSEEK_MODEL=deepseek-chat
# Optional; defaults to ./beta.db
# DATABASE_PATH=/path/to/beta.db
```

Start the server:

```sh
node app.js
```

Alternatively, `npm start` runs `index.js`, and `npm run dev` starts it with
nodemon. Open <http://localhost:3000>. Set `PORT` to use another port. Do not
open `public/index.html` directly from the filesystem; the frontend calls the
server's relative `/api/...` routes.

## Tests and development

```sh
npm test
```

The Jest/Supertest suite covers the journal API, summary/thought persistence,
the protected analysis route, and upgrading an old database schema. The
Python standard-library tests cover the Beta email digest without contacting
Gmail. Tests use temporary databases and do not make live DeepSeek or YouTube
requests.

Useful starting points:

- Frontend markup and browser-side request handling: `public/index.html`
- API endpoints, input validation, AI provider, and transcript integration:
  `app.js`
- Database creation and compatibility migrations: `app.js`, near
  `createJournalTable`, `migrateOldJournalTable`, and `migrateJournalColumns`
- API and migration examples: `__tests__/api.test.js`

## Email new journal entries

`beta_digest.py` sends newly saved summaries and optional thoughts as an email
with both HTML and plain-text alternatives. It reads `GMAIL_SENDER`,
`GMAIL_APP_PASSWORD`, and `GMAIL_RECEIVER` from the sibling Gamma project's
`.env` by default (`../gamma/.env`). It sends one digest for all pending
entries and records delivery state in a `beta_digest_deliveries` table. Gmail
delivery is recorded only after the message is accepted.

The first normal run establishes a baseline and does not email entries already
in the database. Later entries are included in the next digest. Use
`--include-existing` on the first real run if you want a one-time email of
existing entries instead.

Preview what would be sent without sending or marking entries:

```sh
../gamma/gamma/bin/python beta_digest.py --dry-run
```

On the first dry run, the script explains that existing entries would be
baselined; it does not create delivery state. Run it manually with Gamma's
Python virtual environment, or let Gamma's `run_pipeline.py` invoke it after
the market report when the Beta project and `beta.db` are available at
`../beta`. Set `BETA_PROJECT_ROOT` and optionally `BETA_DATABASE_PATH` in the
pipeline environment if the projects or database are elsewhere. The digest is
a separate email from Gamma's market report, keeping report generation
independent.

## Change history

The Git history records the project evolving in these main steps:

| Commit | Change |
|---|---|
| `c515015` — Initial commit | Added the Express/SQLite journal, browser page, transcript and AI experiments, and the initial test/dependency setup. |
| `7ab0867` — PORT and authentication | Made the server use the hosting-provided `PORT` and added an application-password gate for AI analysis. |
| `5138941` — Password prompt and app startup | Reworked the frontend request/password flow, improved error handling and brought `node app.js` startup support into the main server file. |
| `2c0f191` — Separate summaries and thoughts | Renamed the saved summary field to `ai_summary`, added the independent `thoughts` field and form, migrated older database schemas, and documented local setup. |
| `ecd7b73` — Authentication test | Updated the analysis test to assert the intended unauthorized response when no application password is supplied. |

The provider implementation currently uses DeepSeek's OpenAI-compatible chat
API. The completion request allows up to 100,000 output tokens, subject to
DeepSeek model/context limits and the size of the input.

## Local data and secrets

`.env`, `beta.db`, SQLite journal files, and `node_modules/` are excluded from
Git. Never commit API keys or personal journal data. On a second computer,
clone the code, create a private `.env`, install dependencies, and either start
with a fresh database or copy a closed `beta.db` file privately.
