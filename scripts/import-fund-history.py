"""Explicit, offline import into the new workbench, never into the original database."""
import fcntl
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'modules/factors/src'))
from fund_history_store import import_csvs
from fund_nav_engine import BENCHMARKS

if __name__ == '__main__':
    folder = ROOT / 'var/factors'
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'fund-history.import.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('A fund history import is already running.')
        result = import_csvs('/Users/samshi/Projects/fund-warehouse/raw', folder / 'fund-history.sqlite', BENCHMARKS,
                             progress=lambda value: print(json.dumps(value), flush=True))
        print(json.dumps(result, ensure_ascii=False), flush=True)
