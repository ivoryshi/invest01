"""Read-only, single-comparison-group screening of the existing fund CSV."""

import hashlib
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

GROUP_COLUMNS = ["\u7b56\u7565\u7c7b\u578b", "freq_used", "\u57fa\u51c6", "\u57fa\u51c6\u53e3\u5f84"]
GROUP_KEYS = ["strategyType", "frequency", "benchmark", "benchmarkBasis"]


def numeric(series):
    return pd.to_numeric(series.astype("string").str.strip().str.removesuffix("%"), errors="coerce").replace([np.inf, -np.inf], np.nan)


def profile(frame):
    required = GROUP_COLUMNS + ["is_primary"]
    if any(column not in frame for column in required):
        raise ValueError("fund_group_fields_missing")
    frame = frame.copy()
    frame[GROUP_COLUMNS] = frame[GROUP_COLUMNS].fillna("").astype(str)
    frame["_primary"] = numeric(frame["is_primary"]).eq(1).astype(int)
    grouped = frame.groupby(GROUP_COLUMNS, dropna=False).agg(rowCount=("_primary", "size"), primaryCount=("_primary", "sum")).reset_index()
    groups = [{"comparisonGroup": dict(zip(GROUP_KEYS, [row[column] for column in GROUP_COLUMNS])),
               "rowCount": int(row["rowCount"]), "primaryCount": int(row["primaryCount"])} for _, row in grouped.iterrows()]
    return {"rowCount": len(frame), "groups": groups, "groupCount": len(groups)}


def screen(frame, settings, definitions):
    if not isinstance(settings, dict):
        raise ValueError("invalid_fund_settings")
    group = settings.get("comparisonGroup", {})
    if not isinstance(group, dict) or not all(isinstance(group.get(key), str) for key in GROUP_KEYS) or not group.get("strategyType") or not group.get("frequency"):
        raise ValueError("fund_comparison_group_required")
    primary_only = settings.get("primaryShareOnly", True)
    if not isinstance(primary_only, bool):
        raise ValueError("invalid_fund_primary_policy")
    top_n = settings.get("topN", 10)
    if not isinstance(top_n, int) or isinstance(top_n, bool) or not 1 <= top_n <= 100:
        raise ValueError("invalid_fund_top_n")
    min_years = float(settings.get("minHistoryYears", 0))
    if not math.isfinite(min_years) or min_years < 0:
        raise ValueError("invalid_fund_min_history")
    policy = settings.get("missingValuePolicy", "exclude")
    if policy not in ("exclude", "neutral"):
        raise ValueError("unsupported_fund_missing_policy")
    specs = settings.get("rankFields", [])
    if not isinstance(specs, list) or not 1 <= len(specs) <= 12:
        raise ValueError("fund_rank_fields_required")
    by_id = {(item["factorFamilyId"], item["field"]): item for item in definitions}
    selected, used = [], set()
    for spec in specs:
        if not isinstance(spec, dict):
            raise ValueError("invalid_fund_rank_spec")
        key = (spec.get("factorFamilyId"), spec.get("field"))
        definition = by_id.get(key)
        if not definition or definition.get("sourceField") not in frame:
            raise ValueError("fund_factor_field_unavailable")
        if definition["direction"] not in ("higher_is_better", "lower_is_better"):
            raise ValueError("fund_factor_direction_required")
        if definition["factorFamilyId"] == "library.fund.benchmark_relative" and (not group["benchmark"] or not group["benchmarkBasis"]):
            raise ValueError("fund_relative_factor_benchmark_required")
        source = definition["sourceField"]
        if source in used:
            raise ValueError("duplicate_fund_rank_field")
        used.add(source)
        weight = float(spec.get("weight", 0))
        if not math.isfinite(weight) or weight <= 0:
            raise ValueError("invalid_fund_factor_weight")
        selected.append({**definition, "weight": weight})
    total_weight = sum(item["weight"] for item in selected)
    if not math.isfinite(total_weight):
        raise ValueError("invalid_fund_factor_weight")
    for item in selected:
        item["normalizedWeight"] = item["weight"] / total_weight
    required = GROUP_COLUMNS + ["share_code", "share_name", "fund_key", "is_primary"]
    if any(column not in frame for column in required):
        raise ValueError("fund_identity_fields_missing")
    working = frame.copy()
    initial_count = len(working)
    filters = []

    def apply_filter(mask, name):
        nonlocal working
        previous = len(working)
        working = working.loc[mask].copy()
        filters.append({"filter": name, "before": previous, "after": len(working), "excluded": previous - len(working)})

    mask = pd.Series(True, index=working.index)
    for key, column in zip(GROUP_KEYS, GROUP_COLUMNS):
        mask &= working[column].fillna("").astype(str).eq(group[key])
    apply_filter(mask, "comparison_group")
    if working.empty:
        raise ValueError("fund_comparison_group_empty")
    if primary_only:
        apply_filter(numeric(working["is_primary"]).eq(1), "primary_share_only")
        apply_filter(working["fund_key"].notna() & working["fund_key"].astype(str).str.strip().ne(""), "fund_identity_present")
    apply_filter(working["share_code"].notna() & working["share_code"].astype(str).str.strip().ne(""), "share_identity_present")
    working = working.sort_values("share_code", kind="stable")
    apply_filter(~working.duplicated("fund_key" if primary_only else "share_code", keep="first"), "fund_or_share_deduplication")
    if min_years:
        history = "\u5386\u53f2\u5e74\u6570"
        if history not in working:
            raise ValueError("fund_history_field_missing")
        apply_filter(numeric(working[history]).ge(min_years), "minimum_history_years")
    if working.empty:
        raise ValueError("fund_screen_empty_after_filters")
    raw = pd.DataFrame({item["field"]: numeric(working[item["sourceField"]]) for item in selected}, index=working.index)
    missing_counts = {field: int(raw[field].isna().sum()) for field in raw}
    if policy == "exclude":
        apply_filter(raw.notna().all(axis=1), "complete_rank_fields")
        raw = raw.loc[working.index]
    else:
        apply_filter(raw.notna().any(axis=1), "at_least_one_rank_field")
        raw = raw.loc[working.index]
    if working.empty:
        raise ValueError("fund_screen_no_valid_factor_rows")
    scores = pd.DataFrame(index=working.index)
    for item in selected:
        values = raw[item["field"]]
        if values.notna().sum() == 0:
            raise ValueError("fund_rank_field_has_no_valid_values")
        ranked = values.rank(method="average", ascending=item["direction"] == "higher_is_better")
        count = values.notna().sum()
        scores[item["field"]] = ((ranked - 1) / (count - 1) if count > 1 else ranked * 0 + 0.5).fillna(0.5)
    working["_score"] = sum(scores[item["field"]] * item["normalizedWeight"] for item in selected)
    ranked = working.sort_values(["_score", "share_code"], ascending=[False, True], kind="stable")
    candidates = []
    for rank, (index, row) in enumerate(ranked.head(top_n).iterrows(), 1):
        details = [{"factorFamilyId": item["factorFamilyId"], "field": item["field"], "sourceField": item["sourceField"], "name": item["name"], "direction": item["direction"],
                    "rawValue": float(raw.loc[index, item["field"]]) if pd.notna(raw.loc[index, item["field"]]) else None,
                    "score": float(scores.loc[index, item["field"]]), "normalizedWeight": item["normalizedWeight"],
                    "contribution": float(scores.loc[index, item["field"]]) * item["normalizedWeight"], "missing": bool(pd.isna(raw.loc[index, item["field"]]))} for item in selected]
        candidates.append({"rank": rank, "shareCode": str(row["share_code"]), "shareName": str(row["share_name"]),
                           "fundKey": str(row["fund_key"]) if pd.notna(row["fund_key"]) else None,
                           "score": float(row["_score"]), "factorDetails": details,
                           "dataStart": str(row.get("\u6570\u636e\u8d77\u70b9", "")) if pd.notna(row.get("\u6570\u636e\u8d77\u70b9")) else None,
                           "dataEnd": str(row.get("\u6570\u636e\u7ec8\u70b9", "")) if pd.notna(row.get("\u6570\u636e\u7ec8\u70b9")) else None})
    return {"candidates": candidates, "factorDefinitions": selected, "comparisonGroup": group, "filterAudit": filters,
            "missingCounts": missing_counts, "missingCountScope": "after_identity_history_filters_before_missing_policy",
            "metrics": {"sourceRowCount": initial_count, "eligibleCount": len(working), "selectedCount": len(candidates)},
            "missingValuePolicy": policy, "primaryShareOnly": primary_only,
            "rankMethod": "average_rank_0_to_1_within_comparison_group_weighted_sum",
            "warnings": (["missing_values_scored_neutral_0_5"] if policy == "neutral" and any(missing_counts.values()) else [])}


def execute(file_path, mode, payload):
    file_path = Path(file_path)
    before = file_path.stat()
    source_bytes = file_path.read_bytes()
    digest = hashlib.sha256(source_bytes).hexdigest()
    expected = payload.get("expectedSha256")
    if expected and expected != digest:
        raise ValueError("fund_source_version_changed_reload_profile")
    if mode == "profile":
        frame = pd.read_csv(io.BytesIO(source_bytes), usecols=GROUP_COLUMNS + ["is_primary"], dtype="string", encoding="utf-8-sig")
        result = profile(frame)
    elif mode == "screen":
        frame = pd.read_csv(io.BytesIO(source_bytes), dtype="string", encoding="utf-8-sig")
        result = screen(frame, payload["settings"], payload["definitions"])
    else:
        raise ValueError("unsupported_fund_read_mode")
    after = file_path.stat()
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise ValueError("fund_source_changed_retry")
    result["sourceVersion"] = {"sha256": digest, "bytes": after.st_size, "mtimeNs": str(after.st_mtime_ns)}
    return result


if __name__ == "__main__":
    try:
        result = execute(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))
    except (ValueError, KeyError, TypeError) as error:
        result = {"error": str(error)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
