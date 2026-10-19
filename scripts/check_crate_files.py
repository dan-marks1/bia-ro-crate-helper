#!/usr/bin/env python3
"""Compare an RO-Crate file_list.tsv with files in its crate directory.

This standard-library-only preflight reads the RO-Crate JSON and TSV manifest,
then uses filesystem metadata (relative paths and byte sizes). It never opens
the listed data files.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path, PurePosixPath
from typing import Any


SIZE_COLUMNS = ("size_in_bytes", "size_bytes", "file_size_bytes", "filesize_bytes")
IGNORED_NAMES = {".ds_store", "thumbs.db"}


def add(findings: list[dict[str, str]], severity: str, message: str) -> None:
    findings.append({"severity": severity, "message": message})


def graph_entities(crate: Any) -> list[dict[str, Any]]:
    if not isinstance(crate, dict):
        return []
    graph = crate.get("@graph", [])
    return [entity for entity in graph if isinstance(entity, dict)] if isinstance(graph, list) else []


def relative_manifest_path(raw: str) -> tuple[str | None, str | None]:
    value = raw.strip().replace("\\", "/")
    if not value:
        return None, "filepath is empty"
    if value.startswith("/") or (len(value) >= 3 and value[1] == ":" and value[2] == "/"):
        return None, f"filepath must be relative: {raw}"
    path = PurePosixPath(value)
    if ".." in path.parts:
        return None, f"filepath must not escape the crate folder: {raw}"
    normalized = str(PurePosixPath(*(part for part in path.parts if part not in ("", "."))))
    if normalized in ("", "."):
        return None, f"filepath is not a file path: {raw}"
    return normalized, None


def list_data_files(root: Path, file_list: Path, metadata: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    for current, dirs, filenames in os.walk(root, followlinks=False):
        current_path = Path(current)
        dirs[:] = [name for name in dirs if name != "__MACOSX"]
        for name in filenames:
            path = current_path / name
            if name.lower() in IGNORED_NAMES or name.startswith("._"):
                continue
            if path.resolve() in (file_list.resolve(), metadata.resolve()):
                continue
            try:
                if not path.is_file():
                    continue
                relative = path.relative_to(root).as_posix()
            except (OSError, ValueError):
                continue
            files[relative] = path
    return files


def run(crate_dir: Path) -> dict[str, Any]:
    root = crate_dir.expanduser().resolve()
    metadata_path = root / "ro-crate-metadata.json"
    manifest_path = root / "file_list.tsv"
    if not root.is_dir():
        raise ValueError(f"Crate directory does not exist or is not a directory: {root}")
    if not metadata_path.is_file():
        raise ValueError(f"Missing ro-crate-metadata.json in {root}")
    if not manifest_path.is_file():
        raise ValueError(f"Missing file_list.tsv in {root}")

    try:
        with metadata_path.open(encoding="utf-8") as handle:
            crate = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read valid RO-Crate JSON: {exc}") from exc

    findings: list[dict[str, str]] = []
    entities = graph_entities(crate)
    dataset_ids = {
        str(entity.get("@id"))
        for entity in entities
        if any(
            str(value).split(":")[-1] == "Dataset"
            for value in ([entity.get("@type")] if isinstance(entity.get("@type"), str) else entity.get("@type", []))
        )
        and entity.get("@id") is not None
        and str(entity.get("@id")) != "./"
    }

    try:
        with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            headers = [header.strip() for header in (reader.fieldnames or [])]
            rows = list(reader)
    except (OSError, UnicodeError, csv.Error) as exc:
        raise ValueError(f"Could not read file_list.tsv: {exc}") from exc

    header_counts: dict[str, int] = {}
    for header in headers:
        key = header.lower()
        header_counts[key] = header_counts.get(key, 0) + 1
        if header_counts[key] > 1:
            add(findings, "error", f"Duplicate column header: {header}")
    header_lookup = {header.lower(): header for header in headers}
    for required in ("filepath", "dataset", "type"):
        if required not in header_lookup:
            add(findings, "error", f"Required file list column is missing: {required}")
    if "filepath" not in header_lookup:
        rows = []

    path_header = header_lookup.get("filepath")
    dataset_header = header_lookup.get("dataset")
    type_header = header_lookup.get("type")
    size_header = next((header_lookup[name] for name in SIZE_COLUMNS if name in header_lookup), None)
    expected: dict[str, tuple[int, int | None]] = {}
    duplicate_paths = 0
    invalid_sizes = 0
    bad_dataset_refs = 0

    for line, row in enumerate(rows, start=2):
        if None in row or any(value is None for value in row.values()):
            add(findings, "error", f"Row {line} has a different number of values than the header has columns.")
        raw_path = (row.get(path_header) or "").strip() if path_header else ""
        normalized, error = relative_manifest_path(raw_path)
        if error:
            add(findings, "error", f"Row {line}: {error}.")
            continue
        assert normalized is not None
        if normalized in expected:
            duplicate_paths += 1
            add(findings, "error", f"File path {normalized!r} is repeated on rows {expected[normalized][0]} and {line}.")
            continue

        dataset = (row.get(dataset_header) or "").strip() if dataset_header else ""
        if dataset and dataset not in dataset_ids:
            bad_dataset_refs += 1
            add(findings, "error", f"Row {line} references a dataset ID absent from the RO-Crate: {dataset}")
        file_type = (row.get(type_header) or "").strip() if type_header else ""
        if type_header and not file_type:
            add(findings, "warning", f"Row {line} ({normalized}) has an empty type value.")

        declared_size: int | None = None
        if size_header:
            raw_size = (row.get(size_header) or "").strip()
            try:
                declared_size = int(raw_size)
                if declared_size < 0:
                    raise ValueError
            except ValueError:
                invalid_sizes += 1
                add(findings, "error", f"Row {line} ({normalized}) has an invalid byte size: {raw_size!r}.")
                declared_size = None
        expected[normalized] = (line, declared_size)

    actual = list_data_files(root, manifest_path, metadata_path)
    missing = 0
    mismatched = 0
    total_bytes = 0
    for relative, (line, declared_size) in expected.items():
        path = actual.get(relative)
        if path is None:
            missing += 1
            add(findings, "error", f"Listed file was not found in the crate directory (row {line}): {relative}")
            continue
        try:
            actual_size = path.stat().st_size
        except OSError as exc:
            add(findings, "error", f"Could not read file metadata for {relative}: {exc}")
            continue
        total_bytes += actual_size
        if declared_size is not None and declared_size != actual_size:
            mismatched += 1
            add(findings, "error", f"Byte size differs for {relative}: manifest={declared_size}, actual={actual_size}.")

    extras = sorted(set(actual) - set(expected))
    if extras:
        examples = ", ".join(extras[:10])
        suffix = f" Examples: {examples}" if examples else ""
        add(findings, "warning", f"{len(extras)} data file(s) are in the crate directory but not in file_list.tsv.{suffix}")

    errors = sum(item["severity"] == "error" for item in findings)
    warnings = sum(item["severity"] == "warning" for item in findings)
    return {
        "crate_directory": str(root),
        "manifest": str(manifest_path),
        "metadata": str(metadata_path),
        "data_files_found": len(actual),
        "manifest_rows": len(rows),
        "unique_manifest_paths": len(expected),
        "matched_files": len(expected) - missing,
        "missing_files": missing,
        "size_column": size_header,
        "size_mismatches": mismatched,
        "invalid_sizes": invalid_sizes,
        "extra_files": len(extras),
        "duplicate_paths": duplicate_paths,
        "invalid_dataset_references": bad_dataset_refs,
        "selected_data_bytes": total_bytes,
        "error_count": errors,
        "warning_count": warnings,
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("crate_dir", type=Path, help="folder containing ro-crate-metadata.json, file_list.tsv, and crate files")
    parser.add_argument("--json-out", type=Path, help="also write the complete report as JSON to this path")
    args = parser.parse_args()
    try:
        report = run(args.crate_dir)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(f"Crate folder: {report['crate_directory']}")
    print(f"Manifest rows: {report['manifest_rows']} · unique paths: {report['unique_manifest_paths']}")
    print(f"Data files found: {report['data_files_found']} · matched: {report['matched_files']} · missing: {report['missing_files']}")
    print(f"Size mismatches: {report['size_mismatches']} · extra files: {report['extra_files']}")
    print(f"Findings: {report['error_count']} errors · {report['warning_count']} warnings")
    for finding in report["findings"]:
        print(f"[{finding['severity'].upper()}] {finding['message']}")
    if args.json_out:
        output = args.json_out.expanduser()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"JSON report written to: {output.resolve()}")
    return 1 if report["error_count"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
