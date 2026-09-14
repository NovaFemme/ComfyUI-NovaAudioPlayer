"""
nova_tag_writer.py — write a NOVA_TABLE of tag data onto a NOVA_FILES batch.

The node form of tags_start_flac.py: the CSV becomes a SQLite table, the
implicit "files in the working directory" becomes an explicit batch from Nova
Batch Load Audio, and print() becomes a console string you can wire into Nova
Console.

Kept from the original script
  - rows are matched to files by the FileName column, tolerating the
    space/underscore difference in either direction (and now case too)
  - Length is never written: duration comes from the audio stream and is not a
    settable text field

Added
  - every other column is auto-mapped to its tag name, so Copyright and
    EncodedBy are written as well as the original eight
  - FLAC and Ogg take the native Vorbis-comment path; MP4/M4A and ID3-carrying
    formats are mapped to their own frames; anything mutagen cannot tag is
    reported and left untouched
  - dry_run previews the whole run without opening a file for writing
"""

import json
import os
import re
from typing import Any, Dict, List, Tuple

try:
    from .nova_authoring_common import (
        DELIVERY_CATEGORY as AUTHORING_CATEGORY, AUTHORING_VERSION, FILES_TYPE, TABLE_TYPE,
        banner, file_paths, render_value,
    )
except ImportError:  # standalone / direct execution
    from nova_authoring_common import (
        DELIVERY_CATEGORY as AUTHORING_CATEGORY, AUTHORING_VERSION, FILES_TYPE, TABLE_TYPE,
        banner, file_paths, render_value,
    )

# Columns whose obvious lowercase form is not the right tag name.
TAG_ALIASES = {
    "track number": "tracknumber",
    "tracknum": "tracknumber",
    "track": "tracknumber",
    "disc number": "discnumber",
    "disk number": "discnumber",
    "album artist": "albumartist",
    "encoded by": "encodedby",
    "encoder settings": "encodersettings",
    "release date": "date",
    "year": "date",
}

MP4_ATOMS = {
    "title": "\xa9nam", "artist": "\xa9ART", "album": "\xa9alb",
    "date": "\xa9day", "genre": "\xa9gen", "comment": "\xa9cmt",
    "lyrics": "\xa9lyr", "copyright": "cprt", "encodedby": "\xa9too",
    "albumartist": "aART", "composer": "\xa9wrt", "grouping": "\xa9grp",
}

ID3_FRAMES = {
    "title": "TIT2", "artist": "TPE1", "album": "TALB", "date": "TDRC",
    "genre": "TCON", "tracknumber": "TRCK", "discnumber": "TPOS",
    "copyright": "TCOP", "encodedby": "TENC", "albumartist": "TPE2",
    "composer": "TCOM",
}


def _normalise_name(name: str) -> str:
    """'No_Cage_But_Mine.FLAC' and 'No Cage But Mine.flac' collapse to one key."""
    text = os.path.basename(str(name)).strip().lower().replace("_", " ")
    return re.sub(r"\s+", " ", text)


def _tag_name(column: str) -> str:
    key = re.sub(r"\s+", " ", str(column).strip().lower())
    if key in TAG_ALIASES:
        return TAG_ALIASES[key]
    return re.sub(r"[^a-z0-9]", "", key)


def _parse_column_map(text: str) -> Tuple[Dict[str, str], List[str]]:
    """Return (mapping, problems).

    A line that cannot be parsed is REPORTED, never dropped quietly. Silently
    ignoring a line the user clearly meant something by is how a run looks
    successful while doing none of what was asked.

    Note the separator is deliberately "=" only. Accepting ":" as well would
    turn `Encoded By: Crazy Gecko` into "map column 'Encoded By' to a tag named
    'Crazy Gecko'" — a confident, wrong guess at what is almost certainly an
    attempt to set a value rather than rename a column.
    """
    mapping: Dict[str, str] = {}
    problems: List[str] = []
    for number, raw in enumerate((text or "").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            # Kept to a narrow column on purpose: this lands in Nova Console,
            # which does not wrap, so a long single line just runs off the edge.
            detail = [
                f"column_map line {number} ignored: {line}",
                "    the separator is '=', not ':' — expected  Column = tagname",
            ]
            if ":" in line:
                column, _, value = line.partition(":")
                detail += [
                    f"    did you mean:  {column.strip()} = {_tag_name(column)}",
                    "    note: this renames a column to a tag name, it never sets",
                    f"          a value — {value.strip()!r} has to come from the row.",
                ]
            problems.append("\n".join(detail))
            continue
        column, tag = line.split("=", 1)
        column, tag = column.strip(), tag.strip()
        if not column:
            problems.append(f"column_map line {number} ignored: {line}\n"
                            "    no column name before the '='.")
            continue
        mapping[re.sub(r"\s+", " ", column.lower())] = tag
    return mapping, problems


def _build_mapping(columns: List[str], filename_column: str, skip: List[str],
                   overrides: Dict[str, str],
                   problems: List[str] | None = None) -> Dict[str, str]:
    skip_keys = {re.sub(r"\s+", " ", s.strip().lower()) for s in skip if s.strip()}
    skip_keys.add(re.sub(r"\s+", " ", (filename_column or "").strip().lower()))

    # An override naming a column that is not in the table does nothing. Say so:
    # "EncodedBy" and "Encoded By" are different keys, and that is easy to miss.
    if problems is not None:
        known = {re.sub(r"\s+", " ", str(c).strip().lower()) for c in columns}
        for key in overrides:
            if key not in known:
                listing = []
                row = "        "
                for name in columns:
                    if len(row) + len(name) + 2 > 74:
                        listing.append(row.rstrip())
                        row = "        "
                    row += f"{name}, "
                listing.append(row.rstrip().rstrip(","))
                problems.append(
                    f"column_map refers to '{key}', which is not a column in "
                    "this table.\n    the columns are:\n" + "\n".join(listing)
                )

    mapping: Dict[str, str] = {}
    for column in columns:
        key = re.sub(r"\s+", " ", str(column).strip().lower())
        if key in skip_keys:
            continue
        tag = overrides.get(key, _tag_name(column))
        if not tag or tag.lower() in {"-", "skip", "none"}:
            continue
        mapping[column] = tag
    return mapping


# ---------------------------------------------------------------------------
# Format-specific writers
# ---------------------------------------------------------------------------

def _write_vorbis(handle, tags: Dict[str, str]) -> Tuple[List[str], List[str]]:
    for tag, value in tags.items():
        handle[tag] = [value]          # Vorbis comments accept arbitrary keys
    handle.save()
    return list(tags), []


def _write_mp4(handle, tags: Dict[str, str]) -> Tuple[List[str], List[str]]:
    written, unsupported = [], []
    for tag, value in tags.items():
        if tag == "tracknumber":
            try:
                number = int(str(value).split("/")[0])
            except ValueError:
                unsupported.append(tag)
                continue
            handle["trkn"] = [(number, 0)]
            written.append(tag)
        elif tag in MP4_ATOMS:
            handle[MP4_ATOMS[tag]] = [str(value)]
            written.append(tag)
        else:
            handle[f"----:com.apple.iTunes:{tag}"] = [str(value).encode("utf-8")]
            written.append(tag)
    handle.save()
    return written, unsupported


def _write_id3(path: str, tags: Dict[str, str]) -> Tuple[List[str], List[str]]:
    from mutagen.id3 import ID3, COMM, USLT, TXXX, ID3NoHeaderError
    import mutagen.id3 as id3

    try:
        frames = ID3(path)
    except ID3NoHeaderError:
        frames = ID3()

    written: List[str] = []
    for tag, value in tags.items():
        text = str(value)
        if tag == "comment":
            frames.delall("COMM")
            frames.add(COMM(encoding=3, lang="eng", desc="", text=text))
        elif tag == "lyrics":
            frames.delall("USLT")
            frames.add(USLT(encoding=3, lang="eng", desc="", text=text))
        elif tag in ID3_FRAMES:
            name = ID3_FRAMES[tag]
            frames.delall(name)
            frames.add(getattr(id3, name)(encoding=3, text=[text]))
        else:
            frames.delall("TXXX:" + tag)
            frames.add(TXXX(encoding=3, desc=tag, text=[text]))
        written.append(tag)

    frames.save(path)
    return written, []


def _write_tags(path: str, tags: Dict[str, str]) -> Tuple[List[str], List[str], str]:
    """Return (written_tags, unsupported_tags, format_label)."""
    import mutagen
    from mutagen.flac import FLAC
    from mutagen.mp4 import MP4
    from mutagen.oggvorbis import OggVorbis
    from mutagen.oggopus import OggOpus
    from mutagen.oggflac import OggFLAC
    from mutagen.mp3 import MP3

    extension = os.path.splitext(path)[1].lower()
    if extension in (".flac",):
        handle = FLAC(path)
        return (*_write_vorbis(handle, tags), "FLAC/Vorbis")

    handle = mutagen.File(path)
    if handle is None:
        raise ValueError("mutagen has no reader for this container")

    if isinstance(handle, (FLAC, OggVorbis, OggOpus, OggFLAC)):
        return (*_write_vorbis(handle, tags), type(handle).__name__ + "/Vorbis")
    if isinstance(handle, MP4):
        return (*_write_mp4(handle, tags), "MP4 atoms")
    if isinstance(handle, MP3) or extension in (".mp3", ".aiff", ".aif", ".wav"):
        return (*_write_id3(path, tags), "ID3")

    # Last resort: some other mutagen type that still behaves like a mapping.
    try:
        return (*_write_vorbis(handle, tags), type(handle).__name__)
    except Exception as exc:
        raise ValueError(f"{type(handle).__name__} does not accept these tags ({exc})")


class NovaTagWriter:
    CATEGORY = AUTHORING_CATEGORY
    FUNCTION = "write"
    RETURN_TYPES = ("STRING", "INT", "INT", FILES_TYPE)
    RETURN_NAMES = ("console", "written_count", "skipped_count", "files")
    OUTPUT_TOOLTIPS = (
        "Run log — wire this into Nova Console.",
        "Files successfully tagged.",
        "Rows or files that were skipped.",
        "The same batch, passed through so you can chain Nova Tag Reader to verify.",
    )
    DESCRIPTION = (
        f"Nova Tag Writer v{AUTHORING_VERSION} — writes each database row onto the "
        "matching audio file, matched by the FileName column."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "table": (TABLE_TYPE, {"tooltip": "Rows from Nova SQLite Reader."}),
                "files": (FILES_TYPE, {"tooltip": "Batch from Nova Batch Load Audio."}),
                "filename_column": ("STRING", {
                    "default": "FileName",
                    "multiline": False,
                    "tooltip": "Column holding the file name each row belongs to.",
                }),
                "skip_columns": ("STRING", {
                    "default": "Length",
                    "multiline": False,
                    "tooltip": "Comma-separated columns to leave out. Length is skipped by default — duration is not a settable tag.",
                }),
                "column_map": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "EncodedBy = encoded-by\nComment = description\nCopyright = skip",
                    "tooltip": "One 'Column = tagname' per line to override the automatic mapping. Use 'skip' as the tag name to drop a column.",
                }),
                "skip_empty_values": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "On: empty/NULL cells leave the existing tag alone. Off: they overwrite it with an empty value.",
                }),
                "dry_run": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "On: report exactly what would be written without opening any file for writing.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")   # tagging is a side effect; always re-run when asked

    def write(self, table, files, filename_column, skip_columns, column_map,
              skip_empty_values, dry_run, **kwargs):
        rows: List[Dict[str, Any]] = list((table or {}).get("rows") or [])
        columns: List[str] = list((table or {}).get("columns") or [])
        paths = file_paths(files)

        log: List[str] = [banner(f"NOVA TAG WRITER v{AUTHORING_VERSION}")]
        if dry_run:
            log.append("DRY RUN — nothing will be written to disk.")
        log.append(f"Database : {(table or {}).get('database_path', '(none)')}")
        log.append(f"Table    : {(table or {}).get('table', '(none)')}  "
                   f"({len(rows)} row(s), {len(columns)} column(s))")
        log.append(f"Batch    : {(files or {}).get('root', '(none)')}  ({len(paths)} file(s))")

        if not rows:
            log.append("\nNothing to do: the table has no rows.")
            return ("\n".join(log), 0, 0, files)
        if not paths:
            log.append("\nNothing to do: the batch has no files.")
            return ("\n".join(log), 0, 0, files)

        # Which column names hold the filename?
        actual_filename_column = next(
            (c for c in columns if c.lower() == (filename_column or "").strip().lower()),
            None,
        )
        if actual_filename_column is None:
            log.append(
                f"\nERROR: no '{filename_column}' column in the table. "
                f"Available: {', '.join(columns)}"
            )
            return ("\n".join(log), 0, len(rows), files)

        overrides, problems = _parse_column_map(column_map)
        skip_list = [s for s in (skip_columns or "").split(",")]
        mapping = _build_mapping(columns, actual_filename_column, skip_list,
                                 overrides, problems)

        log.append(f"Matching : {actual_filename_column} -> file name "
                   "(case, spaces and underscores all treated as equal)")
        log.append("Tags     : " + (", ".join(f"{c} -> {t}" for c, t in mapping.items()) or "(none)"))
        if problems:
            log.append("")
            for problem in problems:
                first, _, rest = problem.partition("\n")
                log.append(f"WARNING: {first}")
                if rest:
                    log.append(rest)
        log.append("")

        if not mapping:
            log.append("ERROR: every column was skipped — nothing to write.")
            return ("\n".join(log), 0, len(rows), files)

        index: Dict[str, str] = {}
        for path in paths:
            index.setdefault(_normalise_name(path), path)
            index.setdefault(_normalise_name(os.path.splitext(path)[0]), path)

        written = skipped = 0
        used: set = set()
        for row in rows:
            raw_name = row.get(actual_filename_column)
            if raw_name in (None, ""):
                log.append("Row with an empty FileName — skipped.")
                skipped += 1
                continue

            key = _normalise_name(str(raw_name))
            path = index.get(key) or index.get(_normalise_name(os.path.splitext(str(raw_name))[0]))
            if path is None:
                log.append(f"File not found in batch: {raw_name}")
                skipped += 1
                continue

            tags: Dict[str, str] = {}
            for column, tag in mapping.items():
                value = row.get(column)
                text = render_value(value)
                if skip_empty_values and not text.strip():
                    continue
                tags[tag] = text

            if not tags:
                log.append(f"No non-empty values for {os.path.basename(path)} — skipped.")
                skipped += 1
                continue

            used.add(path)
            if dry_run:
                log.append(f"Would tag: {os.path.basename(path)}  [{', '.join(sorted(tags))}]")
                written += 1
                continue

            try:
                applied, unsupported, label = _write_tags(path, tags)
                written += 1
                log.append(f"Successfully tagged: {os.path.basename(path)}  "
                           f"[{label}: {len(applied)} tag(s)]")
                if unsupported:
                    log.append(f"    not supported by this format: {', '.join(unsupported)}")
            except Exception as exc:
                skipped += 1
                log.append(f"Error tagging {os.path.basename(path)}: "
                           f"{type(exc).__name__}: {exc}")

        untouched = [p for p in paths if p not in used]
        if untouched:
            log.append("")
            log.append(f"{len(untouched)} file(s) in the batch had no matching row:")
            for path in untouched[:25]:
                log.append(f"    {os.path.basename(path)}")
            if len(untouched) > 25:
                log.append(f"    … and {len(untouched) - 25} more")

        log.append("")
        log.append(f"Processing complete!  tagged={written}  skipped={skipped}"
                   + ("  (dry run)" if dry_run else ""))

        text = "\n".join(log)
        print(text)
        return (text, written, skipped, files)


NODE_CLASS_MAPPINGS = {"NovaTagWriter": NovaTagWriter}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaTagWriter": "Nova Tag Writer 🏷️"}
