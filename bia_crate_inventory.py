#!/usr/bin/env python3
"""Create a JSON inventory of files in a selected RO-Crate directory.

The script reads names, relative paths, and filesystem sizes only. It does not
open the crate's data files. Set CRATE_DIR below, then run this script from
any directory; the report is written in the selected crate folder.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


# Change this one line to the submission folder you want to inventory.
# You can also override it when running the script with --directory.
CRATE_DIR = Path("/path/to/submission-directory")
FORMAT = "bia-ro-crate-file-inventory"
VERSION = 1
OUTPUT_NAME = "bia-file-inventory.json"
EXCLUDED_ROOT_NAMES = {"ro-crate-metadata.json", "file_list.tsv", "bia_crate_inventory.py", OUTPUT_NAME}
EXCLUDED_NAMES_ANYWHERE = {".ds_store", "thumbs.db"}


def create_inventory(root: Path, output: Path) -> dict[str, object]:
    root = root.resolve()
    output = output.resolve()
    if not root.is_dir():
        raise ValueError(f"Not a directory: {root}")

    files: list[dict[str, object]] = []
    directories: set[str] = set()
    total_bytes = 0
    for current, dir_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        dir_names[:] = sorted(name for name in dir_names if name != "__MACOSX")
        for name in dir_names:
            directory = current_path / name
            if directory.is_symlink():
                continue
            directories.add(directory.relative_to(root).as_posix())
        for name in file_names:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if name.lower() in EXCLUDED_NAMES_ANYWHERE or name.startswith("._"):
                continue
            if "/" not in relative and name.lower() in EXCLUDED_ROOT_NAMES:
                continue
            if path.resolve() == output or path.is_symlink():
                continue
            try:
                size = path.stat().st_size
            except (OSError, ValueError) as exc:
                print(f"Warning: skipped {path}: {exc}", file=sys.stderr)
                continue
            files.append({"path": relative, "size_bytes": size})
            total_bytes += size

    files.sort(key=lambda item: str(item["path"]).casefold())
    directory_list = sorted(directories, key=str.casefold)
    return {
        "format": FORMAT,
        "version": VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "crate_directory": root.name,
        "file_count": len(files),
        "directory_count": len(directory_list),
        "total_bytes": total_bytes,
        "directories": directory_list,
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=CRATE_DIR, help="submission directory to inventory (default: CRATE_DIR in this script)")
    parser.add_argument("--output", type=Path, help=f"report path (default: <submission directory>/{OUTPUT_NAME})")
    args = parser.parse_args()
    root = args.directory.expanduser()
    output = args.output or root / OUTPUT_NAME
    if not output.is_absolute():
        output = root / output
    try:
        report = create_inventory(root, output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(f"Inventory written: {output}")
    print(f"Directories: {report['directory_count']} · data files: {report['file_count']} · total size: {report['total_bytes']:,} bytes")
    print("Only paths and byte sizes were collected; data file contents were not read.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
