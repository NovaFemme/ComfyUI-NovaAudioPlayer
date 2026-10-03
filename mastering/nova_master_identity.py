import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict


# Relative inside ComfyUI, where the pack is a package. Absolute under
# dev/tests, which put the pack root on the path themselves.
try:
    from ..nova_categories import MASTERING
    from ..nova_definitions import identity_fields_from_row
except ImportError:
    from nova_categories import MASTERING
    from nova_definitions import identity_fields_from_row

VERSION = "0.2.6"

def _sha(value: Dict[str, Any]) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

def _clean(value: str) -> str:
    value = (value or "").strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", value)
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"-+", "-", value)
    return value.strip(" .-_") or "Unknown"

_OVERRIDABLE_FIELDS = (
    "artist_name", "track_title", "artist_initials", "track_number", "version",
    "album_title", "catalog_number", "isrc", "publisher", "label",
    "mastering_engineer", "mastering_company", "copyright_owner", "release_year",
    "composer", "producer", "mix_engineer", "project_name", "territory",
    "language", "explicit_flag", "upc_ean", "work_id", "client_reference", "notes",
    "target_bit_depth", "target_sample_rate",
)

_INT_LIMITS = {"track_number": (1, 999), "release_year": (1900, 2200)}

# These are combo widgets: only these exact strings are legal, so a database
# value is reduced to its digits and checked ("24-bit" -> "24") rather than
# trusted. An unrecognised value leaves the widget alone.
_CHOICE_LIMITS = {
    "target_bit_depth": ("24", "16"),
    "target_sample_rate": ("48000", "44100", "96000"),
}


def _parse_fields(value: str) -> Dict[str, Any]:
    """Read the wired field payload, tolerating an empty or blank socket."""
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception as exc:
        raise ValueError(
            "Nova Master Identity: identity_fields_json is not valid JSON "
            f"({exc}). Wire it from Nova SQLite Single Row Filter's single_row_json "
            "output, or type a JSON object of field name to value."
        ) from exc
    if not isinstance(parsed, dict):
        raise ValueError(
            "Nova Master Identity: identity_fields_json must be a JSON object "
            "of field name to value."
        )
    return _map_columns(parsed)


def _map_columns(row: Dict[str, Any]) -> Dict[str, Any]:
    """Accept a raw database row as well as a ready-made field payload.

    Nova SQLite Reader's identity preset mapped column names (Title, Artist,
    Album, ISRC ...) onto this node's field names before handing the row over.
    That node is deprecated, and the nodes that replace it hand over the row as
    it is in the table. So the same mapping is applied here: a row from Nova
    SQLite Single Row Filter works without a translation step in between. A
    payload already keyed by field names passes through unchanged, and keys the
    map does not know are kept, so nothing that worked before is dropped.
    """
    try:
        mapped = identity_fields_from_row(row)
    except Exception:
        return row
    merged = dict(row)
    merged.update(mapped)
    return merged


def _coerce_field(name: str, value: Any) -> Any:
    """Bring a database value into the shape the widget expects.

    Returns None when the value carries nothing usable, so the widget keeps
    whatever it already had.
    """
    if value is None:
        return None
    if name == "explicit_flag":
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if not text:
            return None
        return text in ("1", "true", "yes", "y", "on", "explicit")
    if name in _INT_LIMITS:
        try:
            number = int(str(value).strip())
        except (TypeError, ValueError):
            return None
        low, high = _INT_LIMITS[name]
        return max(low, min(high, number))
    if name in _CHOICE_LIMITS:
        digits = re.sub(r"[^0-9]", "", str(value))
        return digits if digits in _CHOICE_LIMITS[name] else None
    text = str(value).strip()
    return text or None


class NovaMasterIdentity:
    CATEGORY = MASTERING
    FUNCTION = "enrich"
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("identity_json", "fingerprint_json", "archive_name")
    DESCRIPTION = ("Nova Master Identity — turns a mastering report into release and archive identity: "
                   "catalogue fields, provenance fingerprints and an archive file name. It does not touch the audio.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "report_json": ("STRING", {"multiline": True, "default": "",
                    "tooltip": "Nova Audio Master's report_json. The identity and the fingerprints are bound to this report."}),
                "artist_name": ("STRING", {"default": "",
                    "tooltip": "Artist or band name, as it should appear on the release."}),
                "track_title": ("STRING", {"default": "",
                    "tooltip": "Title of this track. Also used in the archive file name."}),
            },
            "optional": {
                "artist_initials": ("STRING", {"default": "",
                    "tooltip": "Short form of the artist name for the archive file name, e.g. NA. Empty: derived from artist_name."}),
                "track_number": ("INT", {"default": 1, "min": 1, "max": 999,
                    "tooltip": "Position on the album. Leads the archive file name as two digits, e.g. 02."}),
                "version": ("STRING", {"default": "Master",
                    "tooltip": "Which version this is, e.g. Master, Radio Edit, Instrumental. Part of the archive file name."}),
                "album_title": ("STRING", {"default": "",
                    "tooltip": "Album or release title."}),
                "catalog_number": ("STRING", {"default": "",
                    "tooltip": "Your label's catalogue number for the release, e.g. NOVA-001."}),
                "isrc": ("STRING", {"default": "",
                    "tooltip": "International Standard Recording Code: 12 characters, e.g. US-S1Z-26-00001. Hyphens are optional."}),
                "publisher": ("STRING", {"default": "",
                    "tooltip": "Music publisher, if any."}),
                "label": ("STRING", {"default": "",
                    "tooltip": "Record label, if any."}),
                "mastering_engineer": ("STRING", {"default": "",
                    "tooltip": "Who mastered the track."}),
                "mastering_company": ("STRING", {"default": "Nova Audio Master",
                    "tooltip": "Studio or tool credited with the mastering."}),
                "copyright_owner": ("STRING", {"default": "",
                    "tooltip": "Owner of the sound recording copyright (the name only, without the year or the symbol)."}),
                "release_year": ("INT", {"default": 2026, "min": 1900, "max": 2200,
                    "tooltip": "Year of release, four digits."}),
                "composer": ("STRING", {"default": "",
                    "tooltip": "Who wrote the music. Separate several names with commas."}),
                "producer": ("STRING", {"default": "",
                    "tooltip": "Who produced the track."}),
                "mix_engineer": ("STRING", {"default": "",
                    "tooltip": "Who mixed the track."}),
                "project_name": ("STRING", {"default": "",
                    "tooltip": "Your own name for the project or session this master belongs to."}),
                "territory": ("STRING", {"default": "",
                    "tooltip": "Where the release is cleared for, e.g. Worldwide, or a list of country codes."}),
                "language": ("STRING", {"default": "",
                    "tooltip": "Language of the lyrics, e.g. English, or an ISO code such as en. Empty for an instrumental."}),
                "explicit_flag": ("BOOLEAN", {"default": False,
                    "tooltip": "On when the lyrics are explicit. Recorded in the identity; nothing is changed in the audio."}),
                "upc_ean": ("STRING", {"default": "",
                    "tooltip": "Barcode of the release: a 12-digit UPC or a 13-digit EAN, digits only, e.g. 012345678905."}),
                "work_id": ("STRING", {"default": "",
                    "tooltip": "Identifier of the composition, e.g. an ISWC such as T-123.456.789-0."}),
                "client_reference": ("STRING", {"default": "",
                    "tooltip": "The client's own reference or job number, if you master for someone else."}),
                "notes": ("STRING", {"multiline": True, "default": "",
                    "tooltip": "Free text kept with the identity record, e.g. a mastering note."}),
                "target_bit_depth": (["24", "16"], {"default": "24",
                    "tooltip": "The bit depth the release is meant to have. Recorded only: this node converts nothing. The save node decides what is written."}),
                "target_sample_rate": (["48000", "44100", "96000"], {"default": "48000",
                    "tooltip": "The sample rate the release is meant to have, in Hz. Recorded only: this node does not resample."}),
                "identity_fields_json": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": (
                        "Field values from a database, as a JSON object. Wire Nova SQLite "
                        "Single Row Filter's single_row_json (rows from Nova Dynamic SQLite "
                        "Browser), or the deprecated Nova SQLite Reader's identity_json. "
                        "Columns are matched by name: Title, Artist, Album, ISRC and so on, "
                        "or this node's own field names. Every field it carries replaces the "
                        "widget of the same name, so the catalogue stays the single source of truth and "
                        "nothing has to be retyped after a browser reset. Blank values "
                        "are ignored, and fields it does not mention keep whatever the "
                        "widgets say."
                    ),
                }),
            },
        }

    def enrich(self, report_json, artist_name, track_title, artist_initials="",
               track_number=1, version="Master", album_title="", catalog_number="",
               isrc="", publisher="", label="", mastering_engineer="",
               mastering_company="Nova Audio Master", copyright_owner="",
               release_year=2026, composer="", producer="", mix_engineer="",
               project_name="", territory="", language="", explicit_flag=False,
               upc_ean="", work_id="", client_reference="", notes="",
               target_bit_depth="24", target_sample_rate="48000",
               identity_fields_json=""):

        # A database row, when one is wired in, outranks the widgets. Widget
        # values live in the workflow JSON and are lost to a browser reset or a
        # reloaded graph; the catalogue is not, which is the whole point of
        # wiring it. Only non-empty values override, so a blank cell never
        # silently clears a field that was filled in by hand.
        applied = {}
        for name, value in _parse_fields(identity_fields_json).items():
            if name not in _OVERRIDABLE_FIELDS:
                continue
            coerced = _coerce_field(name, value)
            if coerced is not None:
                applied[name] = coerced

        artist_name = applied.get("artist_name", artist_name)
        track_title = applied.get("track_title", track_title)
        artist_initials = applied.get("artist_initials", artist_initials)
        track_number = applied.get("track_number", track_number)
        version = applied.get("version", version)
        album_title = applied.get("album_title", album_title)
        catalog_number = applied.get("catalog_number", catalog_number)
        isrc = applied.get("isrc", isrc)
        publisher = applied.get("publisher", publisher)
        label = applied.get("label", label)
        mastering_engineer = applied.get("mastering_engineer", mastering_engineer)
        mastering_company = applied.get("mastering_company", mastering_company)
        copyright_owner = applied.get("copyright_owner", copyright_owner)
        release_year = applied.get("release_year", release_year)
        composer = applied.get("composer", composer)
        producer = applied.get("producer", producer)
        mix_engineer = applied.get("mix_engineer", mix_engineer)
        project_name = applied.get("project_name", project_name)
        territory = applied.get("territory", territory)
        language = applied.get("language", language)
        explicit_flag = applied.get("explicit_flag", explicit_flag)
        upc_ean = applied.get("upc_ean", upc_ean)
        work_id = applied.get("work_id", work_id)
        client_reference = applied.get("client_reference", client_reference)
        notes = applied.get("notes", notes)
        target_bit_depth = applied.get("target_bit_depth", target_bit_depth)
        target_sample_rate = applied.get("target_sample_rate", target_sample_rate)

        if applied:
            print("[Nova Master Identity] from database: "
                  + ", ".join(f"{k}={v!r}" for k, v in sorted(applied.items())))

        try:
            master = json.loads(report_json)
        except Exception as e:
            raise ValueError(f"report_json is not valid JSON: {e}") from e
        if not isinstance(master, dict):
            raise ValueError("report_json must contain a JSON object")

        initials = artist_initials.strip() or "".join(p[0] for p in artist_name.split() if p)[:6].upper()
        identity_id = str(uuid.uuid4())
        created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        publication = {
            "identity_id": identity_id,
            "created_utc": created,
            "identity_node_version": VERSION,
            "recording_identity": {
                "isrc": isrc.strip(), "artist_name": artist_name.strip(),
                "artist_initials": initials, "track_title": track_title.strip(),
                "track_number": int(track_number), "version": version.strip(),
                "album_title": album_title.strip(), "catalog_number": catalog_number.strip(),
                "release_year": int(release_year), "upc_ean": upc_ean.strip(), "work_id": work_id.strip(),
            },
            "rights_and_parties": {
                "publisher": publisher.strip(), "label": label.strip(),
                "copyright_owner": copyright_owner.strip(), "composer": composer.strip(),
                "producer": producer.strip(), "mix_engineer": mix_engineer.strip(),
                "mastering_engineer": mastering_engineer.strip(),
                "mastering_company": mastering_company.strip(),
            },
            "project": {
                "project_name": project_name.strip(), "territory": territory.strip(),
                "language": language.strip(), "explicit": bool(explicit_flag),
                "client_reference": client_reference.strip(), "notes": notes.strip(),
            },
            "planned_delivery": {
                "container": "WAV", "stereo_interleaved": True,
                "bit_depth": int(target_bit_depth), "sample_rate_hz": int(target_sample_rate),
                "conversion_performed_by_identity_node": False,
                "note": "Delivery intent only; conversion/export is reserved for Nova Master Export.",
            },
        }

        parent = master.get("provenance", {}).get("report_id", "")
        root = master.get("lineage", {}).get("root_report_id") or parent
        master["publication_identity"] = publication
        master["lineage"] = {
            "parent_report_id": parent,
            "source_report_id": parent,
            "root_report_id": root,
        }

        sr_k = int(target_sample_rate) / 1000.0
        sr_label = str(int(sr_k)) if sr_k.is_integer() else str(sr_k).rstrip("0").rstrip(".")
        archive_name = (
            f"{int(track_number):02d}_{_clean(initials)}_{_clean(track_title)}_"
            f"{_clean(version)}_{int(target_bit_depth)}-{sr_label}.wav"
        )

        fingerprint = {
            "schema": "nova.master_identity.fingerprint",
            "schema_version": 1,
            "identity_id": identity_id,
            "parent_report_id": parent,
            "source_pcm_sha256": master.get("identity", {}).get("source_pcm_sha256", ""),
            "master_pcm_sha256": master.get("identity", {}).get("master_pcm_sha256", ""),
            "settings_sha256": master.get("identity", {}).get("settings_sha256", ""),
            "reproduction_fingerprint_sha256": master.get("identity", {}).get("reproduction_fingerprint_sha256", ""),
            "report_payload_sha256": master.get("identity", {}).get("report_payload_sha256", ""),
            "recording_identity_sha256": _sha(publication["recording_identity"]),
            "publication_identity_sha256": _sha(publication),
            "archive_name": archive_name,
        }
        fingerprint["fingerprint_record_sha256"] = _sha(fingerprint)
        master["publication_identity"]["publication_identity_sha256"] = fingerprint["publication_identity_sha256"]
        master["archive"] = {
            "archive_name": archive_name,
            "identity_fingerprint_sha256": fingerprint["fingerprint_record_sha256"],
        }

        return (
            json.dumps(master, indent=2, ensure_ascii=False, allow_nan=False),
            json.dumps(fingerprint, indent=2, ensure_ascii=False, allow_nan=False),
            archive_name,
        )

NODE_CLASS_MAPPINGS = {"NovaMasterIdentity": NovaMasterIdentity}
NODE_DISPLAY_NAME_MAPPINGS = {"NovaMasterIdentity": "Nova Master Identity 🪪"}
