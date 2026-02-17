from app.models.frame import Frame
from app.utils.frame_http import _tls_connect_error_detail


def _frame(frame_host: str = "frame.local") -> Frame:
    return Frame(name="f", frame_host=frame_host, status="ok")


def test_tls_connect_error_detail_for_hostname_mismatch():
    detail = _tls_connect_error_detail(
        _frame("turvaraam.local"),
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: Hostname mismatch, certificate is not valid for 'turvaraam.local'.",
    )

    assert detail is not None
    assert "hostname verification failed" in detail.lower()
    assert "turvaraam.local" in detail


def test_tls_connect_error_detail_for_ca_issue():
    detail = _tls_connect_error_detail(
        _frame(),
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self signed certificate in certificate chain",
    )

    assert detail is not None
    assert "client_ca_cert" in detail


def test_tls_connect_error_detail_for_non_tls_error():
    detail = _tls_connect_error_detail(_frame(), "[Errno 111] Connection refused")

    assert detail is None
