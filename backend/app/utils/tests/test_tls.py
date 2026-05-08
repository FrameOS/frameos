from cryptography import x509

from app.utils.tls import generate_frame_tls_material, parse_certificate_not_valid_after


def test_generate_frame_tls_material_returns_pem_blocks():
    material = generate_frame_tls_material("frame.local")
    assert "BEGIN CERTIFICATE" in material["server"]
    assert "BEGIN RSA PRIVATE KEY" in material["server_key"]
    assert "BEGIN CERTIFICATE" in material["client_ca"]


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
