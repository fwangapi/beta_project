#!/usr/bin/env python3
"""Email unsent Beta Journal entries through the Gamma Gmail configuration."""

import argparse
import html
import json
import os
import smtplib
import sqlite3
import sys
from datetime import date, datetime
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv


BETA_ROOT = Path(__file__).resolve().parent
DEFAULT_ENV_FILE = BETA_ROOT.parent / "gamma" / ".env"
DELIVERY_TABLE = "beta_digest_deliveries"


def connect_database(database_path):
    connection = sqlite3.connect(database_path, timeout=10)
    connection.row_factory = sqlite3.Row
    columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(journals)").fetchall()
    }
    required = {"id", "title", "ai_summary", "thoughts", "source", "created_at", "tags_json"}
    if not required.issubset(columns):
        connection.close()
        missing = ", ".join(sorted(required - columns))
        raise RuntimeError(f"Beta database is missing required journal columns: {missing}")
    return connection


def get_pending_entries(connection):
    tables = {
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if DELIVERY_TABLE in tables:
        query = f"""
            SELECT j.id, j.title, j.ai_summary, j.thoughts, j.source, j.created_at, j.tags_json
            FROM journals AS j
            LEFT JOIN {DELIVERY_TABLE} AS d ON d.journal_id = j.id
            WHERE d.journal_id IS NULL
            ORDER BY j.created_at, j.id
        """
    else:
        query = """
            SELECT id, title, ai_summary, thoughts, source, created_at, tags_json
            FROM journals
            ORDER BY created_at, id
        """
    entries = []
    for row in connection.execute(query).fetchall():
        entry = dict(row)
        tags = json.loads(entry.pop("tags_json"))
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            raise RuntimeError(f"Journal entry {entry['id']} has invalid tags_json.")
        entry["tags"] = tags
        entries.append(entry)
    return entries


def delivery_state_exists(connection):
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (DELIVERY_TABLE,),
    ).fetchone() is not None


def _create_delivery_table(connection):
    connection.execute(
        f"""CREATE TABLE IF NOT EXISTS {DELIVERY_TABLE} (
            journal_id INTEGER PRIMARY KEY,
            sent_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'baseline'))
        )"""
    )
    columns = {
        row["name"]
        for row in connection.execute(f"PRAGMA table_info({DELIVERY_TABLE})").fetchall()
    }
    if "status" not in columns:
        connection.execute(
            f"ALTER TABLE {DELIVERY_TABLE} ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'"
        )


def initialize_delivery_baseline(connection, baseline_at=None):
    """Exclude entries already present when digest delivery is first enabled."""
    baseline_at = baseline_at or datetime.now().astimezone().isoformat(timespec="seconds")
    connection.execute("BEGIN IMMEDIATE")
    try:
        _create_delivery_table(connection)
        result = connection.execute(
            f"""INSERT OR IGNORE INTO {DELIVERY_TABLE} (journal_id, sent_at, status)
                SELECT id, ?, 'baseline' FROM journals""",
            (baseline_at,),
        )
        connection.commit()
        return result.rowcount
    except Exception:
        connection.rollback()
        raise


def _source_html(source):
    escaped_source = html.escape(source)
    parsed = urlparse(source)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        href = html.escape(source, quote=True)
        return f'<a href="{href}">{escaped_source}</a>'
    return escaped_source


def build_message(entries, sender, recipient, sent_on=None):
    sent_on = sent_on or date.today()
    subject = f"[Beta Journal] {len(entries)} new entr{'y' if len(entries) == 1 else 'ies'} - {sent_on.isoformat()}"
    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject

    text_sections = [f"Beta Journal: {len(entries)} new entr{'y' if len(entries) == 1 else 'ies'}\n"]
    html_sections = [
        "<!doctype html><html><head><meta charset=\"utf-8\"></head>"
        "<body style=\"font-family:Arial,sans-serif;max-width:760px;margin:auto;color:#1e293b\">",
        f"<h1>Beta Journal</h1><p>{len(entries)} new journal entr{'y' if len(entries) == 1 else 'ies'}</p>",
    ]
    for entry in entries:
        title = entry["title"]
        summary = entry["ai_summary"]
        thoughts = entry["thoughts"]
        source = entry["source"]
        created = entry["created_at"]
        tags = entry["tags"]

        text_sections.extend([
            f"## {title}",
            f"Created: {created}",
            f"Source: {source}",
            f"Tags: {', '.join(tags) if tags else '(none)'}",
            "",
            "AI Summary",
            summary,
        ])
        if thoughts:
            text_sections.extend(["", "My thoughts", thoughts])
        text_sections.append("\n" + ("-" * 72) + "\n")

        escaped_title = html.escape(title)
        escaped_summary = html.escape(summary)
        escaped_created = html.escape(created)
        escaped_tags = html.escape(", ".join(tags) if tags else "(none)")
        summary_html = f"<div style=\"white-space:pre-wrap;line-height:1.55\">{escaped_summary}</div>"
        thoughts_html = ""
        if thoughts:
            thoughts_html = (
                "<h3>My thoughts</h3>"
                f"<div style=\"white-space:pre-wrap;line-height:1.55\">{html.escape(thoughts)}</div>"
            )
        html_sections.append(
            "<article style=\"border:1px solid #dbe3ee;border-radius:8px;padding:18px;margin:18px 0\">"
            f"<h2>{escaped_title}</h2>"
            f"<p style=\"color:#64748b\">{escaped_created} · {_source_html(source)}</p>"
            f"<p><strong>Tags:</strong> {escaped_tags}</p>"
            f"<h3>AI Summary</h3>{summary_html}{thoughts_html}</article>"
        )

    html_sections.append("</body></html>")
    message.set_content("\n".join(text_sections))
    message.add_alternative("\n".join(html_sections), subtype="html")
    return message


def send_email(message, sender, password, recipient):
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as server:
        server.login(sender, password)
        refused = server.send_message(message, from_addr=sender, to_addrs=[recipient])
        if refused:
            raise RuntimeError(f"Gmail refused delivery to: {', '.join(refused)}")


def mark_entries_sent(connection, entries, sent_at=None):
    sent_at = sent_at or datetime.now().astimezone().isoformat(timespec="seconds")
    connection.execute("BEGIN IMMEDIATE")
    try:
        _create_delivery_table(connection)
        connection.executemany(
            f"""INSERT OR IGNORE INTO {DELIVERY_TABLE} (journal_id, sent_at, status)
                VALUES (?, ?, 'sent')""",
            [(entry["id"], sent_at) for entry in entries],
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Email new Beta Journal entries using Gamma's Gmail settings.")
    parser.add_argument(
        "--database",
        type=Path,
        default=BETA_ROOT / "beta.db",
        help="Path to the Beta SQLite database (default: beta.db beside this script).",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help="Path to Gamma's .env file (default: ../gamma/.env).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview pending entries without sending or changing delivery state.",
    )
    parser.add_argument(
        "--include-existing",
        action="store_true",
        help="On the first real run only, email entries already in the database instead of baselining them.",
    )
    args = parser.parse_args(argv)

    if not args.database.is_file():
        raise RuntimeError(f"Beta database not found: {args.database}")
    if not args.env_file.is_file():
        raise RuntimeError(f"Gamma environment file not found: {args.env_file}")
    load_dotenv(args.env_file, override=False)

    connection = connect_database(args.database)
    try:
        if not delivery_state_exists(connection):
            if args.dry_run:
                if args.include_existing:
                    entries = get_pending_entries(connection)
                    print(f"Dry run: {len(entries)} existing entries would be emailed.")
                else:
                    count = connection.execute("SELECT COUNT(*) FROM journals").fetchone()[0]
                    print(
                        f"Dry run: first run would baseline {count} existing entries without emailing them. "
                        "Entries added after setup will be emailed."
                    )
                return 0
            if args.include_existing:
                print("Including existing Beta Journal entries in the first digest.")
            else:
                count = initialize_delivery_baseline(connection)
                print(f"Baselined {count} existing Beta Journal entr{'y' if count == 1 else 'ies'}; none were emailed.")

        entries = get_pending_entries(connection)
        if not entries:
            print("No new Beta Journal entries to email.")
            return 0
        if args.dry_run:
            print(f"Dry run: {len(entries)} new Beta Journal entr{'y' if len(entries) == 1 else 'ies'} would be emailed.")
            return 0

        sender = os.getenv("GMAIL_SENDER")
        password = os.getenv("GMAIL_APP_PASSWORD")
        recipient = os.getenv("GMAIL_RECEIVER")
        if not sender or not password or not recipient:
            raise RuntimeError(
                "Set GMAIL_SENDER, GMAIL_APP_PASSWORD, and GMAIL_RECEIVER in Gamma's .env."
            )

        message = build_message(entries, sender, recipient)
        send_email(message, sender, password, recipient)
        mark_entries_sent(connection, entries)
        print(f"Sent {len(entries)} Beta Journal entr{'y' if len(entries) == 1 else 'ies'} to {recipient}.")
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Beta digest failed: {error}", file=sys.stderr)
        sys.exit(1)
