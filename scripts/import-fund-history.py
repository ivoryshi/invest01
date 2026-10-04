"""Explicit, offline import into the new workbench, never into the original database."""
import fcntl
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'modules/factors/src'))
from fund_history_store import BENCHMARKS, import_csvs

def main():
    parser = argparse.ArgumentParser(description='Offline, SHA-idempotent CSV import; no fetching or benchmark refresh.')
    parser.add_argument('--raw-root', default=os.environ.get('FUND_HISTORY_RAW_ROOT', '/Users/samshi/Projects/fund-warehouse/raw'))
    parser.add_argument('--nav-codes', nargs='+', help='Only these six-digit share codes; omitted means all existing NAV CSVs.')
    parser.add_argument('--skip-benchmarks', action='store_true', help='Keep previously imported benchmark data unchanged.')
    parser.add_argument('--benchmark-ids', nargs='+', choices=sorted(BENCHMARKS), help='Only these existing benchmark CSVs.')
    args = parser.parse_args()
    if args.skip_benchmarks and args.benchmark_ids:
        parser.error('--skip-benchmarks and --benchmark-ids are mutually exclusive')
    folder = ROOT / 'var/factors'
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'fund-history.import.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('A fund history import is already running.')
        # Full default imports retain the old optional-benchmark behavior; explicit IDs audit absence.
        benchmarks = [] if args.skip_benchmarks else args.benchmark_ids or [key for key in BENCHMARKS if (Path(args.raw_root)/'bench'/f'{key}.csv').exists()]
        result = import_csvs(args.raw_root, folder / 'fund-history.sqlite', benchmarks,
                             progress=lambda value: print(json.dumps(value), flush=True), nav_codes=args.nav_codes,
                             require_benchmarks=bool(args.benchmark_ids))
        print(json.dumps(result, ensure_ascii=False), flush=True)
        if result['lastImport']['rejected']:
            raise SystemExit(2)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.Error) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
