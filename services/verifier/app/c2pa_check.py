"""C2PA (Content Credentials) provenance check.

C2PA is an open standard where the *capturing device or editing app* signs a
manifest ("this photo was taken by a Pixel 9 at 10:42; then cropped in
Lightroom") and embeds it in the file. If anyone changes the pixels afterwards,
the hash inside the signed manifest no longer matches and validation fails.

Status mapping (docs/API.md):
    valid        manifest present, no validation failures (trusted or not, see below)
    invalid      manifest present, but validation found failures (e.g. tampered pixels)
    absent       file read fine, it simply has no manifest (normal for most uploads)
    error        the library failed unexpectedly (corrupt file, unsupported container...)
    unsupported  no original was sent, or the c2pa library is not installed

Library: ``c2pa-python`` 0.38 (wraps the Rust ``c2pa-rs`` SDK). API used:
    ctx = c2pa.Context(c2pa.Settings.from_dict({...}))
    reader = c2pa.Reader.try_create(mime_or_None, stream, None, ctx)  # None = no manifest
    reader.get_validation_state()   -> "Valid" | "Invalid" | "Trusted"
    reader.get_validation_results() -> {"activeManifest": {"success": [...], "failure": [...]}}
    reader.get_active_manifest()    -> dict with "signature_info", "claim_generator(_info)"

Trust note: we do not configure a C2PA trust list yet, so a self-signed manifest
reports ``signingCredential.untrusted``. "Untrusted" is not tampering: the
signature is cryptographically correct, we just don't know who the signer is.
We therefore ignore that one code when deciding valid/invalid and surface the
issuer so a human admin can judge it. Configuring the official C2PA trust list
is a documented follow-up (README).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import IO, Any

from app.schemas import C2paResult

log = logging.getLogger(__name__)

try:  # The native wheel may be missing on exotic platforms; never crash the service.
    import c2pa

    C2PA_AVAILABLE = True
    C2PA_VERSION: str | None = c2pa.sdk_version()
except Exception:  # pragma: no cover - depends on the platform
    c2pa = None  # type: ignore[assignment]
    C2PA_AVAILABLE = False
    C2PA_VERSION = None

# Validation codes that do not mean "this file was tampered with".
# - signingCredential.untrusted: valid signature from a signer not on our trust list.
# - signingCredential.ocsp.skipped / timeStamp.untrusted: we disable network lookups.
NON_TAMPER_CODES: frozenset[str] = frozenset(
    {
        "signingCredential.untrusted",
        "signingCredential.ocsp.skipped",
        "signingCredential.ocsp.unknown",
        "timeStamp.untrusted",
    }
)

# Never let an uploaded file make this server fetch URLs (a remote manifest URL
# or OCSP responder chosen by the uploader would be an SSRF vector).
_READER_SETTINGS: dict[str, Any] = {
    "verify": {
        "remote_manifest_fetch": False,
        "ocsp_fetch": False,
    }
}


def _failure_codes(results: Mapping[str, Any] | None) -> list[str]:
    """Collect failure codes from the active manifest and its ingredients."""
    if not results:
        return []
    codes: list[str] = []
    active = results.get("activeManifest") or {}
    codes.extend(str(item.get("code", "")) for item in active.get("failure", []) or [])
    for ingredient in results.get("ingredientDeltas", []) or []:
        deltas = (ingredient or {}).get("validationDeltas") or {}
        codes.extend(str(item.get("code", "")) for item in deltas.get("failure", []) or [])
    return codes


def _claim_generator(manifest: Mapping[str, Any]) -> str | None:
    """Return the app that produced the manifest.

    C2PA v1 manifests have a ``claim_generator`` string; v2 manifests use a
    ``claim_generator_info`` list of ``{name, version}`` objects.
    """
    legacy = manifest.get("claim_generator")
    if isinstance(legacy, str) and legacy:
        return legacy
    info = manifest.get("claim_generator_info")
    if isinstance(info, list) and info and isinstance(info[0], Mapping):
        name = info[0].get("name")
        version = info[0].get("version")
        if name:
            return f"{name}/{version}" if version else str(name)
    return None


def _issuer(manifest: Mapping[str, Any]) -> str | None:
    sig = manifest.get("signature_info")
    if isinstance(sig, Mapping):
        issuer = sig.get("issuer") or sig.get("common_name")
        return str(issuer) if issuer else None
    return None


def check_c2pa(original: IO[bytes] | None, mime_type: str | None = None) -> C2paResult:
    """Read and validate a C2PA manifest from ``original``. Never raises.

    Args:
        original: a seekable binary stream (the uploaded original), or None.
        mime_type: content type hint; when missing or generic the library
            sniffs the format from the bytes.
    """
    if original is None or not C2PA_AVAILABLE:
        return C2paResult(status="unsupported")

    fmt = mime_type if mime_type and mime_type != "application/octet-stream" else None
    try:
        original.seek(0)
        ctx = c2pa.Context(c2pa.Settings.from_dict(_READER_SETTINGS))
        reader = c2pa.Reader.try_create(fmt, original, None, ctx)
        if reader is None:  # File parsed, no JUMBF/C2PA data inside.
            return C2paResult(status="absent")
        with reader:
            manifest = reader.get_active_manifest() or {}
            state = reader.get_validation_state()
            all_codes = _failure_codes(reader.get_validation_results())
            issuer = _issuer(manifest)
            generator = _claim_generator(manifest)
    except Exception as exc:  # Any library failure becomes "error", never a 500.
        log.warning("c2pa check failed", extra={"error_type": type(exc).__name__})
        return C2paResult(status="error")

    tamper_codes = [c for c in all_codes if c not in NON_TAMPER_CODES]
    # The SDK says "Invalid" but listed no reasons we can inspect: stay cautious.
    unexplained_invalid = state == "Invalid" and not all_codes
    if tamper_codes or unexplained_invalid:
        log.info("c2pa validation failed", extra={"codes": tamper_codes, "state": state})
        return C2paResult(status="invalid", issuer=issuer, claim_generator=generator)
    return C2paResult(status="valid", issuer=issuer, claim_generator=generator)
