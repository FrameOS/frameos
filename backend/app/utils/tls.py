from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta, timezone
from typing import Optional

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def _subject_alt_names(frame_host: str) -> list[x509.GeneralName]:
    sans: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    if frame_host:
        try:
            sans.append(x509.IPAddress(ipaddress.ip_address(frame_host)))
        except ValueError:
            sans.append(x509.DNSName(frame_host))
    return sans


def generate_frame_tls_material(frame_host: str) -> dict[str, str]:
    now = datetime.now(timezone.utc)

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_subject = _name(f"FrameOS Frame CA ({frame_host or 'frame'})")
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_subject)
        .issuer_name(ca_subject)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=False,
                key_cert_sign=True,
                key_agreement=False,
                content_commitment=False,
                data_encipherment=False,
                encipher_only=False,
                decipher_only=False,
                crl_sign=True,
            ),
            critical=True,
        )
        .sign(private_key=ca_key, algorithm=hashes.SHA256())
    )

    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    server_cert = (
        x509.CertificateBuilder()
        .subject_name(_name(frame_host or "frame.local"))
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=825))
        .add_extension(
            x509.SubjectAlternativeName(_subject_alt_names(frame_host)),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                key_cert_sign=False,
                key_agreement=False,
                content_commitment=False,
                data_encipherment=False,
                encipher_only=False,
                decipher_only=False,
                crl_sign=False,
            ),
            critical=True,
        )
        .sign(private_key=ca_key, algorithm=hashes.SHA256())
    )

    return {
        "tls_server_key": server_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ).decode("utf-8"),
        "tls_server_cert": server_cert.public_bytes(serialization.Encoding.PEM).decode("utf-8"),
        "tls_client_ca_cert": ca_cert.public_bytes(serialization.Encoding.PEM).decode("utf-8"),
    }


def parse_certificate_not_valid_after(pem_certificate: Optional[str]) -> Optional[datetime]:
    if not pem_certificate:
        return None

    try:
        cert = x509.load_pem_x509_certificate(pem_certificate.encode("utf-8"))
    except ValueError:
        return None

    if hasattr(cert, "not_valid_after_utc"):
        return cert.not_valid_after_utc

    return cert.not_valid_after
