"""Bounded, read-only samples from registered factor datasets."""

import csv
import datetime
import itertools
import json
import math
import sys
from pathlib import Path


def clean(value):
    if value is None or value == "" or isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def preview(file_path, query):
    file_path = Path(file_path)
    offset = query.get("offset", 0)
    limit = query.get("limit", 20)
    scan_limit = 5000
    total_rows = None
    handle = None
    if file_path.suffix == ".csv":
        handle = file_path.open(encoding="utf-8-sig", newline="")
        reader = csv.DictReader(handle)
        columns = reader.fieldnames or []
        iterator = iter(reader)
    elif file_path.suffix == ".parquet":
        import pyarrow.parquet as pq

        parquet = pq.ParquetFile(file_path)
        columns = parquet.schema_arrow.names
        total_rows = parquet.metadata.num_rows
        iterator = None
    else:
        raise ValueError("unsupported_asset_format")
    try:
        selected = query.get("fields") or columns[:8]
        if not selected or len(selected) > 12 or any(field not in columns for field in selected):
            raise ValueError("invalid_fields")
        date_field = query.get("dateField") or ("date" if "date" in columns else "")
        if date_field and date_field not in columns:
            raise ValueError("invalid_date_field")
        if (query.get("startDate") or query.get("endDate")) and not date_field:
            raise ValueError("date_field_required")
        read_columns = list(dict.fromkeys(selected + ([date_field] if date_field else [])))
        if iterator is None:
            iterator = (row for batch in parquet.iter_batches(batch_size=256, columns=read_columns)
                        for row in batch.to_pylist())
        iterator = itertools.islice(iterator, offset, None)
        rows = []
        scanned = 0
        exhausted = False
        needle = query.get("q", "").casefold()
        while scanned < scan_limit and len(rows) < limit:
            try:
                row = next(iterator)
            except StopIteration:
                exhausted = True
                break
            scanned += 1
            date = str(clean(row.get(date_field)) or "")[:10] if date_field else ""
            if date and (query.get("startDate") or query.get("endDate")):
                try:
                    datetime.date.fromisoformat(date)
                except ValueError:
                    raise ValueError("invalid_date_value") from None
            if query.get("startDate") and (not date or date < query["startDate"]):
                continue
            if query.get("endDate") and (not date or date > query["endDate"]):
                continue
            sample = {field: clean(row.get(field)) for field in selected}
            if needle and not any(needle in str(value).casefold() for value in sample.values() if value is not None):
                continue
            rows.append(sample)
        next_offset = offset + scanned
        if total_rows is not None:
            exhausted = next_offset >= total_rows
        elif exhausted:
            total_rows = next_offset
        return {
            "columns": selected,
            "rows": rows,
            "rowCount": len(rows),
            "totalRows": total_rows,
            "scannedRows": scanned,
            "offset": offset,
            "scanLimit": scan_limit,
            "nextOffset": None if exhausted else next_offset,
            "complete": exhausted,
            "scope": "returned_sample_only",
            "missingCounts": {field: sum(row[field] is None for row in rows) for field in selected},
            "dateField": date_field or None,
            "keywordScope": "selected_fields_only",
        }
    finally:
        if handle:
            handle.close()


if __name__ == "__main__":
    try:
        result = preview(sys.argv[1], json.loads(sys.argv[2]))
    except ValueError as error:
        result = {"error": str(error)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
