"""Offline SQLite backup packs and non-overwriting recovery; no old-project writes."""

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path

from fund_history_store import SCHEMA_VERSION, now, open_reader, status

FORMAT_VERSION = 1
MAX_MANIFEST_BYTES = 16 * 1024


def safe_path(path):
    path = Path(path).absolute()
    if any(part.is_symlink() for part in [path, *path.parents]):
        raise ValueError('fund_backup_symlink_not_allowed')
    return path


def digest(file):
    sha = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def inspect_database(database):
    db = open_reader(database)
    try:
        if [row[0] for row in db.execute('PRAGMA integrity_check')] != ['ok']:
            raise ValueError('fund_backup_database_integrity_failed')
        # Provenance is read from the copied database, not the potentially changing live source.
        sha = hashlib.sha256()
        for row in db.execute('SELECT * FROM sources ORDER BY source_id'):
            sha.update(canonical(dict(row)) + b'\n')
        summary = status(db)
        if summary['lastImport'] and summary['lastImport']['status'] == 'running':
            raise ValueError('fund_backup_import_in_progress')
        return {'schemaVersion': SCHEMA_VERSION, 'sourceDigest': sha.hexdigest(),
                'sourceSummary': summary['sources'], 'lastImport': summary['lastImport']}
    finally:
        db.close()


def identity(payload):
    return hashlib.sha256(canonical(payload)).hexdigest()


def sync_directory(directory):
    handle = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


def create_directory(directory):
    missing = []
    current = directory
    while not current.exists():
        missing.append(current)
        current = current.parent
    directory.mkdir(parents=True, exist_ok=True)
    for item in reversed(missing):
        sync_directory(item.parent)


def verify_pack(folder):
    folder = safe_path(folder)
    manifest_file = safe_path(folder/'manifest.json')
    database = safe_path(folder/'database.sqlite')
    if any(Path(str(database)+suffix).exists() for suffix in ['-wal', '-shm', '-journal']):
        raise ValueError('fund_backup_pack_has_sidecars')
    if not manifest_file.is_file() or manifest_file.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError('fund_backup_manifest_missing_or_too_large')
    manifest = json.loads(manifest_file.read_bytes())
    payload = manifest.get('payload') if isinstance(manifest, dict) else None
    if not isinstance(payload, dict) or payload.get('formatVersion') != FORMAT_VERSION:
        raise ValueError('fund_backup_unsupported_format')
    if manifest.get('backupId') != identity(payload) or folder.name != manifest['backupId']:
        raise ValueError('fund_backup_manifest_identity_mismatch')
    if not database.is_file() or database.stat().st_size != payload.get('bytes') or digest(database) != payload.get('sha256'):
        raise ValueError('fund_backup_database_hash_mismatch')
    if inspect_database(database) != payload.get('database'):
        raise ValueError('fund_backup_database_provenance_mismatch')
    return manifest


def create_pack(database, output_dir):
    database, output_dir = safe_path(database), safe_path(output_dir)
    create_directory(output_dir)
    staging = Path(tempfile.mkdtemp(prefix='.staging-', dir=output_dir))
    try:
        copied = staging/'database.sqlite'
        source = open_reader(database)
        try:
            target = sqlite3.connect(copied)
            try:
                # SQLite's online backup includes committed WAL content; copying only .sqlite does not.
                source.backup(target, pages=1024, sleep=0.05)
                target.execute('PRAGMA journal_mode=DELETE')
            finally:
                target.close()
        finally:
            source.close()
        with copied.open('rb') as stream:
            os.fsync(stream.fileno())
        payload = {'formatVersion': FORMAT_VERSION, 'sha256': digest(copied),
                   'bytes': copied.stat().st_size, 'database': inspect_database(copied)}
        manifest = {'backupId': identity(payload), 'createdAt': now(), 'payload': payload}
        with (staging/'manifest.json').open('xb') as stream:
            stream.write(canonical(manifest))
            stream.flush()
            os.fsync(stream.fileno())
        sync_directory(staging)
        destination = output_dir/manifest['backupId']
        if destination.exists():
            verified = verify_pack(destination)
            # A previous attempt may have published the directory but failed its final sync.
            sync_directory(output_dir)
            return verified
        try:
            staging.rename(destination)
        except OSError:
            if not destination.is_dir():
                raise
            verified = verify_pack(destination)
            sync_directory(output_dir)
            return verified
        sync_directory(output_dir)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def restore_pack(folder, output):
    folder, output = safe_path(folder), safe_path(output)
    manifest = verify_pack(folder)
    if output.exists() or any(Path(str(output)+suffix).exists() for suffix in ['-wal', '-shm', '-journal']):
        raise ValueError('fund_backup_restore_target_exists')
    create_directory(output.parent)
    handle, staging_name = tempfile.mkstemp(prefix='.restore-', suffix='.sqlite', dir=output.parent)
    os.close(handle)
    staging = Path(staging_name)
    try:
        shutil.copyfile(folder/'database.sqlite', staging)
        # Recheck the actual recovery bytes, including a source change during copy.
        if digest(staging) != manifest['payload']['sha256'] or inspect_database(staging) != manifest['payload']['database']:
            raise ValueError('fund_backup_restore_copy_mismatch')
        with staging.open('rb') as stream:
            os.fsync(stream.fileno())
        # Same-directory hard-link publication is atomic and cannot overwrite an existing target.
        os.link(staging, output)
        sync_directory(output.parent)
        return {'status': 'restored_to_new_file', 'backupId': manifest['backupId'], 'output': str(output),
                'sha256': manifest['payload']['sha256']}
    finally:
        staging.unlink(missing_ok=True)
        sync_directory(output.parent)
