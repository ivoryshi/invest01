"""Workbench-owned SQLite history; offline CSV ingestion, read-only research queries."""

import csv
import hashlib
import io
import json
import math
import re
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
BENCHMARKS = ['CSI300', 'CSI500', 'CSI800', 'CSI1000', 'CSI2000', 'CSIA500', 'CSI100', 'CSIALL', 'SSE50', 'STAR50', 'STAR100', 'CHINEXT', 'CHINEXT50', 'DIVIDEND', 'SZ100', 'BONDALL', 'BONDGOV', 'BONDCORP', 'CONVBOND']
SCHEMA = """
CREATE TABLE IF NOT EXISTS store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shares(code TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(
 source_id TEXT PRIMARY KEY, kind TEXT NOT NULL, code TEXT NOT NULL,
 sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, imported_at TEXT NOT NULL,
 observations INTEGER NOT NULL, start_date TEXT, end_date TEXT, metadata TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history(
 kind TEXT NOT NULL, code TEXT NOT NULL, date TEXT NOT NULL, value REAL NOT NULL CHECK(value > 0),
 unit_nav REAL, PRIMARY KEY(kind, code, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS import_runs(
 run_id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
 imported INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS import_errors(
 run_id INTEGER NOT NULL, source_id TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(run_id, source_id));
"""


def now():
    return datetime.now(timezone.utc).isoformat()


def open_reader(database, expected_sha256=None):
    file = Path(database)
    if file.is_symlink() or not file.is_file():
        raise ValueError('fund_history_database_not_imported')
    if expected_sha256 is not None:
        raw, sha = read_file(file, 64*1024*1024)
        if sha != expected_sha256:
            raise ValueError('frozen_snapshot_integrity_failed')
        # Deserialize precisely the bytes hashed above, avoiding a verify/open path replacement race.
        db = sqlite3.connect(':memory:')
        try:
            db.deserialize(raw)
            db.execute('PRAGMA query_only=ON')
        except Exception:
            db.close()
            raise
    else:
        db = sqlite3.connect(file.resolve().as_uri() + '?mode=ro', uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        if db.execute("SELECT value FROM store_meta WHERE key='schema_version'").fetchone()[0] != str(SCHEMA_VERSION):
            raise ValueError('fund_history_unsupported_schema_version')
        db.execute('BEGIN')
        return db
    except Exception:
        db.close()
        raise


def version(row):
    return {'sourceId': row['source_id'], 'sha256': row['sha256'], 'bytes': row['bytes']}


def status(db):
    totals = db.execute("SELECT kind, COUNT(*) AS files, SUM(observations) AS rows, MIN(start_date) AS start, MAX(end_date) AS end FROM sources GROUP BY kind").fetchall()
    last = db.execute('SELECT * FROM import_runs ORDER BY run_id DESC LIMIT 1').fetchone()
    errors = [] if last is None else [dict(row) for row in db.execute('SELECT source_id, message FROM import_errors WHERE run_id=? ORDER BY source_id LIMIT 20', (last['run_id'],))]
    selection_row = db.execute("SELECT value FROM store_meta WHERE key='snapshot_selection'").fetchone()
    selection = json.loads(selection_row[0]) if selection_row else None
    summaries = [dict(row) for row in totals]
    if selection:
        for row in summaries:
            if row['kind'] == 'universe':
                row['rows'] = len(selection['codes'])
    return {'schemaVersion': SCHEMA_VERSION, 'storage': 'workbench_sqlite', 'sources': summaries,
            'lastImport': dict(last) if last else None, 'rejectedSample': errors,
            'selection': selection, 'policy': 'selected_snapshot_source_receipts_not_full_universe' if selection else 'offline_explicit_import_no_fetch_old_csv_readonly'}


def source(db, source_id):
    row = db.execute('SELECT * FROM sources WHERE source_id=?', (source_id,)).fetchone()
    if row is None:
        raise ValueError('fund_history_source_not_imported_' + source_id)
    return row


def read_file(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError('fund_history_source_unavailable_or_size_limit')
    raw = path.read_bytes()
    if len(raw) > limit:
        raise ValueError('fund_history_source_size_limit')
    return raw, hashlib.sha256(raw).hexdigest()


def positive(value):
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError) as error:
        raise ValueError('fund_history_invalid_positive_value') from error
    if not math.isfinite(number) or number <= 0:
        raise ValueError('fund_history_invalid_positive_value')
    return number


def ingest_file(db, path, source_id, kind, code):
    raw, sha = read_file(path, 16*1024*1024 if kind == 'universe' else 4*1024*1024)
    old = db.execute('SELECT sha256 FROM sources WHERE source_id=?', (source_id,)).fetchone()
    if old is not None and old[0] == sha:
        return 'skipped'
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    required = {'share_code', 'share_name'} if kind == 'universe' else {'date', 'adj_nav', 'unit_nav', 'source', 'adj_method', 'freq'} if kind == 'nav' else {'date', 'close', 'kind', 'source_code'}
    if not required <= set(reader.fieldnames or []):
        raise ValueError('fund_history_required_columns_missing')
    records, dates, seen, metadata = [], [], set(), {}
    fields = ['source', 'adj_method', 'freq'] if kind == 'nav' else ['kind', 'source_code'] if kind == 'benchmark' else []
    if kind == 'nav' and db.execute('SELECT 1 FROM shares WHERE code=?', (code,)).fetchone() is None:
        raise ValueError('fund_history_share_not_in_universe')
    for row in reader:
        if any(row.get(field) is None for field in required):
            raise ValueError('fund_history_truncated_row')
        if kind == 'universe':
            key = row['share_code']
            if not re.fullmatch(r'[0-9]{6}', key or '') or not row['share_name'] or key in seen:
                raise ValueError('fund_history_invalid_or_duplicate_share_code')
            seen.add(key); records.append((key, row['share_name'], json.dumps(row, ensure_ascii=False)))
            continue
        text = row['date']
        if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', text or '') or date.fromisoformat(text).isoformat() != text or text in seen:
            raise ValueError('fund_history_invalid_or_duplicate_date')
        seen.add(text); dates.append(text)
        value = positive(row['adj_nav'] if kind == 'nav' else row['close'])
        unit = positive(row['unit_nav']) if kind == 'nav' and row['unit_nav'] else None
        records.append((kind, code, text, value, unit))
        for field in fields:
            if not row[field] or field in metadata and metadata[field] != row[field]:
                raise ValueError('fund_history_inconsistent_' + field)
            metadata[field] = row[field]
    if len(records) < (1 if kind == 'universe' else 2):
        raise ValueError('fund_history_insufficient_rows')
    if kind == 'nav' and ((metadata['adj_method'], metadata['source']) not in [('self_calc', 'offex_unit'), ('hfq', 'onex_hfq')] or metadata['freq'] not in ['日频', '非日频']):
        raise ValueError('fund_history_unsupported_adjustment_source_frequency')
    if kind == 'benchmark' and metadata['kind'] not in ['全收益', '价格']:
        raise ValueError('fund_history_unsupported_benchmark_kind')
    # The replacement and provenance commit together; failures leave the previous source intact.
    with db:
        if kind == 'universe':
            db.execute('DELETE FROM shares'); db.executemany('INSERT INTO shares VALUES(?,?,?)', records)
        else:
            db.execute('DELETE FROM history WHERE kind=? AND code=?', (kind, code))
            db.executemany('INSERT INTO history VALUES(?,?,?,?,?)', records)
        db.execute('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (source_id, kind, code, sha, len(raw), now(), len(records), min(dates) if dates else None, max(dates) if dates else None, json.dumps(metadata, ensure_ascii=False)))
    return 'imported'


def import_csvs(root, database, benchmark_ids, progress=None, nav_codes=None, require_benchmarks=False):
    if nav_codes is not None and (not isinstance(nav_codes, (list, tuple)) or
            any(not isinstance(code, str) or not re.fullmatch(r'[0-9]{6}', code) for code in nav_codes) or
            len(set(nav_codes)) != len(nav_codes)):
        raise ValueError('fund_history_invalid_nav_selection')
    if (not isinstance(benchmark_ids, (list, tuple)) or
            any(not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_]+', key) for key in benchmark_ids) or
            len(set(benchmark_ids)) != len(benchmark_ids)):
        raise ValueError('fund_history_invalid_benchmark_selection')
    root, database = Path(root), Path(database)
    if database.is_symlink() or root.is_symlink() or any((root/name).is_symlink() for name in ['nav', 'bench']):
        raise ValueError('fund_history_symlink_not_allowed')
    database.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(database, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript(SCHEMA)
        previous = db.execute("SELECT value FROM store_meta WHERE key='schema_version'").fetchone()
        if previous and previous[0] != str(SCHEMA_VERSION):
            raise ValueError('fund_history_unsupported_schema_version')
        with db:
            db.execute("INSERT OR IGNORE INTO store_meta VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
            # Serialize imports across processes, and recover interrupted runs explicitly.
            db.execute("UPDATE import_runs SET status='interrupted', finished_at=? WHERE status='running'", (now(),))
            run_id = db.execute("INSERT INTO import_runs(started_at,status) VALUES(?,'running')", (now(),)).lastrowid
        counts = {'imported': 0, 'skipped': 0, 'rejected': 0}
        try:
            counts[ingest_file(db, root/'universe_master.csv', 'universe_master', 'universe', '')] += 1
        except (ValueError, OSError, UnicodeError, csv.Error) as error:
            with db:
                db.execute('INSERT INTO import_errors VALUES(?,?,?)', (run_id, 'universe_master', str(error)))
                db.execute("UPDATE import_runs SET status='failed', finished_at=?, rejected=1 WHERE run_id=?", (now(), run_id))
            raise ValueError('fund_history_universe_import_failed_' + str(error)) from error
        # Explicit selections include missing files so they are audited, never silently skipped.
        nav_files = sorted((root/'nav').glob('*.csv')) if nav_codes is None else [root/'nav'/f'{code}.csv' for code in sorted(nav_codes)]
        files = [(file, 'nav.'+file.stem, 'nav', file.stem) for file in nav_files if re.fullmatch(r'[0-9]{6}', file.stem)]
        files += [(root/'bench'/f'{key}.csv', 'benchmark.'+key, 'benchmark', key) for key in benchmark_ids
                  if require_benchmarks or (root/'bench'/f'{key}.csv').exists()]
        for index, (file, source_id, kind, code) in enumerate(files, 1):
            try:
                counts[ingest_file(db, file, source_id, kind, code)] += 1
            except (ValueError, OSError, UnicodeError, csv.Error) as error:
                counts['rejected'] += 1
                with db:
                    db.execute('INSERT INTO import_errors VALUES(?,?,?)', (run_id, source_id, str(error)))
            if index % 250 == 0:
                with db:
                    db.execute('UPDATE import_runs SET imported=?, skipped=?, rejected=? WHERE run_id=?', (*counts.values(), run_id))
                if progress:
                    progress({'processed': index, 'total': len(files), **counts})
        with db:
            db.execute('UPDATE import_runs SET finished_at=?,status=?,imported=?,skipped=?,rejected=? WHERE run_id=?',
                       (now(), 'completed_with_rejections' if counts['rejected'] else 'completed', *counts.values(), run_id))
        return status(db)
    finally:
        db.close()
