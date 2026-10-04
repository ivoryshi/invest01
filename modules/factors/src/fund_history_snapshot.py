"""Capture selected full histories in one read transaction, not the live database file."""

import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

import fund_history_store as store

MAX_BYTES = 64 * 1024 * 1024


def capture(database, output, selection):
    if not isinstance(selection, dict) or set(selection) != {'codes', 'benchmarkId', 'sourceVersions'}:
        raise ValueError('fund_snapshot_selection_required')
    codes, benchmark = selection['codes'], selection['benchmarkId']
    if (not isinstance(codes, list) or not 1 <= len(codes) <= 10 or
            any(not isinstance(code, str) or not re.fullmatch(r'[0-9]{6}', code) for code in codes) or len(set(codes)) != len(codes)):
        raise ValueError('fund_snapshot_unique_codes_max_10')
    if benchmark not in store.BENCHMARKS:
        raise ValueError('fund_snapshot_registered_benchmark_required')
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise ValueError('fund_snapshot_output_exists')
    created = False
    db = store.open_reader(database)
    try:
        ids = ['universe_master'] + ['nav.'+code for code in codes] + ['benchmark.'+benchmark]
        sources = [dict(store.source(db, key)) for key in ids]
        versions = [store.version(row) for row in sources]
        if selection['sourceVersions'] != versions:
            raise ValueError('fund_nav_source_version_changed_reload_profile')
        normalized = {'codes': sorted(codes), 'benchmarkId': benchmark,
                      'sourceVersions': [versions[0]] + sorted(versions[1:-1], key=lambda x: x['sourceId']) + [versions[-1]]}
        # Exclusive creation prevents even local callers from clobbering an existing database.
        with output.open('xb'):
            pass
        created = True
        target = sqlite3.connect(output)
        try:
            target.execute('PRAGMA page_size=4096')
            target.execute('PRAGMA journal_mode=DELETE')
            target.execute(f'PRAGMA max_page_count={MAX_BYTES//4096}')
            target.executescript(store.SCHEMA)
            with target:
                target.executemany('INSERT INTO store_meta VALUES(?,?)',
                                   [('schema_version', str(store.SCHEMA_VERSION)),
                                    ('snapshot_selection', json.dumps(normalized, sort_keys=True, separators=(',', ':')))])
                for code in sorted(codes):
                    share = db.execute('SELECT code,name,metadata FROM shares WHERE code=?', (code,)).fetchone()
                    if share is None:
                        raise ValueError('fund_snapshot_share_missing')
                    target.execute('INSERT INTO shares VALUES(?,?,?)', tuple(share))
                for row in sorted(sources, key=lambda x: x['source_id']):
                    target.execute('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?)',
                                   tuple(row[key] for key in ['source_id', 'kind', 'code', 'sha256', 'bytes', 'imported_at', 'observations', 'start_date', 'end_date', 'metadata']))
                    if row['kind'] == 'universe':
                        continue
                    count = 0
                    cursor = db.execute('SELECT kind,code,date,value,unit_nav FROM history WHERE kind=? AND code=? ORDER BY date', (row['kind'], row['code']))
                    while batch := cursor.fetchmany(2000):
                        target.executemany('INSERT INTO history VALUES(?,?,?,?,?)', [tuple(item) for item in batch])
                        count += len(batch)
                    if count != row['observations']:
                        raise ValueError('fund_snapshot_source_row_count_mismatch')
            if [row[0] for row in target.execute('PRAGMA integrity_check')] != ['ok']:
                raise ValueError('fund_snapshot_sqlite_integrity_failed')
        finally:
            target.close()
        raw = output.read_bytes()
        if len(raw) > MAX_BYTES:
            raise ValueError('snapshot_freeze_size_limit')
        return {'selection': normalized, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    except Exception:
        if created:
            output.unlink(missing_ok=True)
            for suffix in ['-journal', '-wal', '-shm']:
                Path(str(output)+suffix).unlink(missing_ok=True)
        raise
    finally:
        db.close()


if __name__ == '__main__':
    try:
        result = capture(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error) as error:
        result = {'error': str(error)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
