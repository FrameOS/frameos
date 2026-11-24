## A TLS client handshake that checks the server's certificate against the
## address asked for, an IP literal included.
##
## std/net's `wrapConnectedSocket` checks the certificate's name only when
## the host is a name (`net.nim`, `not isIpAddress(hostname)`): to
## `https://203.0.113.9` any certificate a trusted CA signed for any name
## was the server. A frame reaches its backend and many a scene's sources by
## address, so the address is checked here (OpenSSL's `X509_check_ip_asc`,
## the IP SANs), after the handshake and before a byte is sent.
import std/net
import std/openssl

when not defined(nimDisableCertificateValidation) and not defined(windows):
  proc X509_check_ip_asc(cert: PX509, address: cstring, flags: cuint): cint {.cdecl, importc.}

proc wrapTlsClient*(ctx: SslContext, socket: Socket, host: string) =
  ## `ctx.wrapConnectedSocket(socket, handshakeAsClient, host)`, and for an
  ## IP literal the certificate must name that address. Raises SslError when
  ## it does not, as std/net does for a name.
  ctx.wrapConnectedSocket(socket, handshakeAsClient, host)
  when not defined(nimDisableCertificateValidation) and not defined(windows):
    if host.len > 0 and isIpAddress(host):
      let certificate = socket.sslHandle.SSL_get_peer_certificate()
      if certificate.isNil:
        raise newException(SslError, "No SSL certificate found.")
      let match = certificate.X509_check_ip_asc(host.cstring, 0)
      X509_free(certificate)
      if match != 1:
        raise newException(SslError, "SSL certificate does not name the address " & host)
