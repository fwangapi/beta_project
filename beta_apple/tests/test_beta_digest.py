import sqlite3
import tempfile
import unittest
from datetime import date
from email.message import EmailMessage
from pathlib import Path

from beta_digest import (
    build_message,
    get_pending_entries,
    initialize_delivery_baseline,
    mark_entries_sent,
)


class BetaDigestTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "beta.db"
        self.connection = sqlite3.connect(self.database_path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute(
            """CREATE TABLE journals (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                ai_summary TEXT NOT NULL DEFAULT '',
                thoughts TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL,
                created_at TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]'
            )"""
        )
        self.connection.execute(
            """INSERT INTO journals
               (id, title, ai_summary, thoughts, source, created_at, tags_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                3,
                "<Video>",
                "<script>alert(1)</script>",
                "A thought & reflection",
                "https://example.com/video",
                "2026-09-28 10:00:00",
                '["ai", "research"]',
            ),
        )
        self.connection.commit()

    def tearDown(self):
        self.connection.close()
        self.temp_dir.cleanup()

    def test_only_unmailed_entries_are_pending(self):
        pending = get_pending_entries(self.connection)
        self.assertEqual([entry["id"] for entry in pending], [3])

        mark_entries_sent(self.connection, pending, "2026-09-28T10:05:00+10:00")
        self.assertEqual(get_pending_entries(self.connection), [])

        self.connection.execute(
            """INSERT INTO journals
               (id, title, ai_summary, thoughts, source, created_at, tags_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (4, "New entry", "New summary", "", "Manual", "2026-09-28 11:00:00", "[]"),
        )
        self.connection.commit()
        self.assertEqual([entry["id"] for entry in get_pending_entries(self.connection)], [4])

    def test_first_run_baselines_existing_entries_and_only_emails_future_entries(self):
        baseline_count = initialize_delivery_baseline(
            self.connection, "2026-09-28T10:05:00+10:00"
        )
        self.assertEqual(baseline_count, 1)
        self.assertEqual(get_pending_entries(self.connection), [])

        self.connection.execute(
            """INSERT INTO journals
               (id, title, ai_summary, thoughts, source, created_at, tags_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (4, "New entry", "New summary", "", "Manual", "2026-09-28 11:00:00", "[]"),
        )
        self.connection.commit()
        self.assertEqual([entry["id"] for entry in get_pending_entries(self.connection)], [4])

    def test_message_has_plain_text_and_escaped_html(self):
        entries = get_pending_entries(self.connection)
        message = build_message(entries, "sender@example.com", "reader@example.com", date(2026, 9, 28))

        self.assertIsInstance(message, EmailMessage)
        self.assertEqual(message["Subject"], "[Beta Journal] 1 new entry - 2026-09-28")
        self.assertEqual(message.get_content_type(), "multipart/alternative")
        self.assertIn("A thought & reflection", message.get_body(("plain",)).get_content())

        html_body = message.get_body(("html",)).get_content()
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html_body)
        self.assertNotIn("<script>alert(1)</script>", html_body)
        self.assertIn('href="https://example.com/video"', html_body)


if __name__ == "__main__":
    unittest.main()
