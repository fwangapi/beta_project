# Restore the original YouTube/manual-paste Beta

This package contains unchanged copies of your earlier uploads:

- `app.js`: originally uploaded as `app(2).js` on 4 October 2026.
- `public/index.html`: originally uploaded as `index(1).html` on 4 October 2026.
- `README.md`: originally uploaded as `README(2).md` on 4 October 2026.

These files have YouTube transcript retrieval and manual text input, with no
Apple/RSS/publisher transcript capture. This is a partial source snapshot, not
a complete repository backup. Keep your existing `index.js`, package files,
email-digest files and other project files.

## Apply the rollback

1. Stop the Beta Node server (Ctrl+C in its terminal, or identify its current PID
   using `ss -ltnp 'sport = :3001'` and stop that verified Beta process).
2. In `/home/jas/codex-work/beta`, back up `beta.db` and the current source files:

   ```bash
   backup_dir="backup-before-youtube-rollback-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$backup_dir/public"
   cp beta.db app.js README.md "$backup_dir/"
   cp public/index.html "$backup_dir/public/"
   ```

   If `.env` defines a different `DATABASE_PATH`, back up that database instead.
3. Extract this ZIP into the project folder, replacing `app.js`,
   `public/index.html` and `README.md`. Preserve the `public/` subfolder.
4. Keep your current `.env`, `beta.db`, `index.js`, `package.json`,
   `package-lock.json`, installed dependencies and other project files.
   There is no need to restore an older database or uninstall extra packages.
   The Apple/publisher module files can remain unused by this original backend.
5. Start with `npm start`, or `node app.js`, and leave the terminal open.
6. Open `http://localhost:3001` and press Ctrl+Shift+R to load the restored UI.

## What the original version saves

The original version saves title, AI summary, personal thoughts, source and tags.
It uses fetched/pasted transcript text for analysis but does not save new raw
transcripts or analysis provenance. The existing newer database's extra columns
and stored transcript text are not deliberately removed by this version; the old
interface does not display or update those fields.

Existing journal entries should remain available. Stop and report any startup
database error rather than deleting or replacing `beta.db`.

## Validation

The three restored files were checked byte-for-byte against their earlier
uploads. The backend and inline frontend JavaScript passed syntax checks.
No live YouTube or DeepSeek call was made for this rollback package.
