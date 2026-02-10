from cryptography import x509

from app.utils.tls import generate_frame_tls_material


def test_generate_frame_tls_material_returns_pem_blocks():
    material = generate_frame_tls_material("frame.local")
    assert "BEGIN CERTIFICATE" in material["tls_server_cert"]
    assert "BEGIN RSA PRIVATE KEY" in material["tls_server_key"]
    assert "BEGIN CERTIFICATE" in material["tls_client_ca_cert"]


def test_generate_frame_tls_material_server_cert_contains_host_san():
    material = generate_frame_tls_material("frame.local")
    cert = x509.load_pem_x509_certificate(material["tls_server_cert"].encode("utf-8"))
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert "frame.local" in san.get_values_for_type(x509.DNSName)
