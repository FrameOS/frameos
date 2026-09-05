from cryptography import x509

from app.utils.tls import generate_frame_tls_material, parse_certificate_not_valid_after


def test_generate_frame_tls_material_returns_pem_blocks():
    material = generate_frame_tls_material("frame.local")
    assert "BEGIN CERTIFICATE" in material["server"]
    assert "BEGIN EC PRIVATE KEY" in material["server_key"]
    assert "BEGIN CERTIFICATE" in material["client_ca"]


def test_generate_frame_tls_material_server_key_is_p256_and_small():
    # The pair is stored in the ESP32's NVS as PEM (16 KB on the 4/8 MB
    # layouts); an RSA-2048 pair cost ~2.9 KB, P-256 must stay well under half.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    material = generate_frame_tls_material("frame.local")
    key = serialization.load_pem_private_key(material["server_key"].encode("utf-8"), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    assert key.curve.name == "secp256r1"
    cert = x509.load_pem_x509_certificate(material["server"].encode("utf-8"))
    assert cert.public_key().public_numbers() == key.public_key().public_numbers()
    assert len(material["server"]) + len(material["server_key"]) < 1400


def test_generate_frame_tls_material_server_cert_chains_to_client_ca():
    material = generate_frame_tls_material("frame.local")
    cert = x509.load_pem_x509_certificate(material["server"].encode("utf-8"))
    ca = x509.load_pem_x509_certificate(material["client_ca"].encode("utf-8"))
    cert.verify_directly_issued_by(ca)


def test_generate_frame_tls_material_server_cert_contains_host_san():
    material = generate_frame_tls_material("frame.local")
    cert = x509.load_pem_x509_certificate(material["server"].encode("utf-8"))
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert "frame.local" in san.get_values_for_type(x509.DNSName)


def test_parse_certificate_not_valid_after_returns_datetime_for_valid_pem():
    material = generate_frame_tls_material("frame.local")
    parsed = parse_certificate_not_valid_after(material["server"])
    cert = x509.load_pem_x509_certificate(material["server"].encode("utf-8"))

    if hasattr(cert, "not_valid_after_utc"):
        expected = cert.not_valid_after_utc
    else:
        expected = cert.not_valid_after

    assert parsed == expected


def test_parse_certificate_not_valid_after_returns_none_for_invalid_pem():
    assert parse_certificate_not_valid_after("not-a-certificate") is None
