import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

from ..nova_categories import MASTERING

VERSION = "0.2.5"

def _sha(value: Dict[str, Any]) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

def _clean(value: str) -> str:
    value = (value or "").strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", value)
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"-+", "-", value)
    return value.strip(" .-_") or "Unknown"

class NovaMasterIdentity:
    CATEGORY = MASTERING
    FUNCTION = "enrich"
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("identity_json", "fingerprint_json", "archive_name")
    DESCRIPTION = "Nova Master Identity v0.2.5: publishing, catalogue and mastering provenance."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "report_json": ("STRING", {"multiline": True, "default": ""}),
                "artist_name": ("STRING", {"default": ""}),
                "track_title": ("STRING", {"default": ""}),
            },
            "optional": {
                "artist_initials": ("STRING", {"default": ""}),
                "track_number": ("INT", {"default": 1, "min": 1, "max": 999}),
                "version": ("STRING", {"default": "Master"}),
                "album_title": ("STRING", {"default": ""}),
                "catalog_number": ("STRING", {"default": ""}),
                "isrc": ("STRING", {"default": ""}),
                "publisher": ("STRING", {"default": ""}),
                "label": ("STRING", {"default": ""}),
                "mastering_engineer": ("STRING", {"default": ""}),
                "mastering_company": ("STRING", {"default": "Nova Audio Master"}),
                "copyright_owner": ("STRING", {"default": ""}),
                "release_year": ("INT", {"default": 2026, "min": 1900, "max": 2200}),
                "composer": ("STRING", {"default": ""}),
                "producer": ("STRING", {"default": ""}),
                "mix_engineer": ("STRING", {"default": ""}),
                "project_name": ("STRING", {"default": ""}),
                "territory": ("STRING", {"default": ""}),
                "language": ("STRING", {"default": ""}),
                "explicit_flag": ("BOOLEAN", {"default": False}),
                "upc_ean": ("STRING", {"default": ""}),
                "work_id": ("STRING", {"default": ""}),
                "client_reference": ("STRING", {"default": ""}),
                "notes": ("STRING", {"multiline": True, "default": ""}),
                "target_bit_depth": (["24", "16"], {"default": "24"}),
                "target_sample_rate": (["48000", "44100", "96000"], {"default": "48000"}),
            },
        }

    def enrich(self, report_json, artist_name, track_title, artist_initials="",
               track_number=1, version="Master", album_title="", catalog_number="",
               isrc="", publisher="", label="", mastering_engineer="",
               mastering_company="Nova Audio Master", copyright_owner="",
               release_year=2026, composer="", producer="", mix_engineer="",
               project_name="", territory="", language="", explicit_flag=False,
               upc_ean="", work_id="", client_reference="", notes="",
               target_bit_depth="24", target_sample_rate="48000"):

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
