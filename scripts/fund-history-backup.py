"""Manual create/verify/restore-to-new CLI; never swaps the active database."""

import argparse
import fcntl
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'modules/factors/src'))
from fund_history_backup import create_pack, restore_pack, safe_path, verify_pack


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('create', help='Capture the workbench DB through SQLite online backup.')
    create.add_argument('--output-dir', type=Path, default=ROOT/'var/factors/database-backups')
    verify = commands.add_parser('verify', help='Check identity, full SHA, SQLite integrity and source provenance.')
    verify.add_argument('pack', type=Path)
    restore = commands.add_parser('restore', help='Recover into a NEW file only; active DB is never replaced.')
    restore.add_argument('pack', type=Path)
    restore.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'create':
        folder = safe_path(ROOT/'var/factors')
        folder.mkdir(parents=True, exist_ok=True)
        with (folder/'fund-history.import.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = create_pack(folder/'fund-history.sqlite', args.output_dir)
    elif args.command == 'verify':
        result = {'status': 'verified', **verify_pack(args.pack)}
    else:
        result = restore_pack(args.pack, args.output)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, KeyError, TypeError, IndexError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
