"""Output-path assembly.

`file_path` is DERIVED, never stored: it is a pure function of the four naming
fields, so there is no way for the parts and the whole to disagree. A stored
copy would eventually be edited on one side only.

Shape: `folder/prefix<sep>name`. The folder keeps a real slash because that is
what ComfyUI's `filename_prefix` inputs expect — a subdirectory under the
output root — while the separator joins the name fragments. They are different
jobs and using one character for both would force a choice between nesting and
naming.

Empty fields collapse rather than leaving their punctuation behind. A dangling
`NOVA_` or a leading `/` is the kind of thing nobody notices until a hundred
files carry it.
"""


def build_file_path(prefix="", name="", folder="", separator="_"):
    """Assemble `folder/prefix<separator>name` from whatever is filled in."""
    prefix = (prefix or "").strip()
    name = (name or "").strip()
    folder = (folder or "").strip()
    # The separator is deliberately NOT stripped: a space is a legitimate
    # separator and stripping it would silently turn "a b" into "ab".
    sep = separator if separator is not None else "_"

    # Only the fragments that exist take part, so an empty prefix does not
    # leave a leading separator.
    stem = sep.join([p for p in (prefix, name) if p])

    # Tolerate a folder typed with or without slashes at either end, and
    # collapse any doubling rather than producing "out//NOVA".
    folder = folder.replace("\\", "/").strip("/")
    if not folder:
        return stem
    if not stem:
        return folder
    return f"{folder}/{stem}"
