"""C2PA status mapping, including real signed and tampered files.

We sign a JPEG with a throw-away certificate chain generated on the fly
(``cryptography``, a dev dependency), so the test needs no fixtures on disk and
no network. The signer is not on any trust list, which is exactly the
"valid signature, unknown signer" case we expect from most real devices today.
"""

from __future__ import annotations

import datetime as dt
import io

import pytest

from app import c2pa_check
from app.c2pa_check import check_c2pa
from tests.conftest import make_image_bytes

c2pa = pytest.importorskip("c2pa")
pytest.importorskip("cryptography")


def _sign_jpeg(jpeg: bytes) -> bytes:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    def name(cn: str) -> x509.Name:
        return x509.Name(
            [
                x509.NameAttribute(NameOID.COMMON_NAME, cn),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Micky Test"),
            ]
        )

    now = dt.datetime.now(dt.UTC)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca = (
        x509.CertificateBuilder()
        .subject_name(name("Test Root CA"))
        .issuer_name(name("Test Root CA"))
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    key = ec.generate_private_key(ec.SECP256R1())
    leaf = (
        x509.CertificateBuilder()
        .subject_name(name("Test Signer"))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    pem = serialization.Encoding.PEM
    chain = leaf.public_bytes(pem) + ca.public_bytes(pem)
    private = key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())

    signer = c2pa.Signer.from_info(c2pa.C2paSignerInfo(c2pa.C2paSigningAlg.ES256, chain, private, None))
    manifest = {
        "claim_generator_info": [{"name": "micky-test", "version": "1.0"}],
        "title": "test.jpg",
        "assertions": [
            {
                "label": "c2pa.actions",
                "data": {
                    "actions": [
                        {
                            "action": "c2pa.created",
                            "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
                        }
                    ]
                },
            }
        ],
    }
    out = io.BytesIO()
    with c2pa.Builder(manifest) as builder:
        builder.sign(signer, "image/jpeg", io.BytesIO(jpeg), out)
    return out.getvalue()


@pytest.fixture(scope="module")
def signed_jpeg() -> bytes:
    return _sign_jpeg(make_image_bytes(3, size=(256, 192)))


def test_unsupported_when_no_original() -> None:
    assert check_c2pa(None).status == "unsupported"


def test_unsupported_when_library_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(c2pa_check, "C2PA_AVAILABLE", False)
    assert check_c2pa(io.BytesIO(make_image_bytes())).status == "unsupported"


def test_absent_for_plain_jpeg() -> None:
    result = check_c2pa(io.BytesIO(make_image_bytes()), "image/jpeg")
    assert result.status == "absent"
    assert result.issuer is None and result.claim_generator is None


def test_absent_with_generic_mime_type_sniffs_format() -> None:
    assert check_c2pa(io.BytesIO(make_image_bytes()), "application/octet-stream").status == "absent"


def test_error_for_garbage() -> None:
    assert check_c2pa(io.BytesIO(b"not a media file"), "image/jpeg").status == "error"


def test_valid_signed_jpeg(signed_jpeg: bytes) -> None:
    result = check_c2pa(io.BytesIO(signed_jpeg), "image/jpeg")
    assert result.status == "valid"
    assert result.issuer == "Micky Test"
    assert result.claim_generator == "micky-test/1.0"


def test_invalid_when_pixels_are_tampered(signed_jpeg: bytes) -> None:
    tampered = bytearray(signed_jpeg)
    tampered[-200] ^= 0xFF  # flip bits inside the image data, after the manifest
    result = check_c2pa(io.BytesIO(bytes(tampered)), "image/jpeg")
    assert result.status == "invalid"
    assert result.issuer == "Micky Test"  # still reported, for the admin
