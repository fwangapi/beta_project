# Beta Journal

A local Node.js journal for importing YouTube transcripts, generating AI
summaries with DeepSeek, and saving personal thoughts alongside them.

## Requirements

- Node.js 18 or newer
- A DeepSeek API key for AI summaries
- An application password for protected transcript and analysis requests

## Run locally

```sh
npm ci
```

Create a `.env` file in the project root:

```dotenv
APP_PASSWORD=choose-a-private-password
DEEPSEEK_API_KEY=your-deepseek-api-key
# Optional; defaults to deepseek-chat
# DEEPSEEK_MODEL=deepseek-chat
```

Start the app:

```sh
node app.js
```

Open <http://localhost:3000>. The server creates `beta.db` locally if it does
not exist. `DATABASE_PATH` can be set to choose another database file. The app
also migrates older journal database schemas when it starts.

## Journal fields

- **AI Summary** contains the generated summary and can be edited.
- **My thoughts** is a separate optional field for personal notes.
- Both fields are stored in the local SQLite database.

## Local data and privacy

`.env` and SQLite database files are excluded from Git. To move the journal to
another computer, stop the app and copy `beta.db` privately; do not commit the
database or API credentials. Each computer otherwise uses its own database.

Transcript fetching uses an unofficial YouTube transcript interface and may
fail if YouTube changes or blocks requests. The app can also analyze a
transcript pasted manually. Keeping the app local makes transcript requests
originate from your own network.
