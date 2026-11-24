## A TLS client handshake that checks the server's certificate against the
## address asked for, an IP literal included.
##
## std/net's `wrapConnectedSocket` checks the certificate's name only when
## the host is a name (`net.nim`, `not isIpAddress(hostname)`): to
## `https://203.0.113.9` any certificate a trusted CA signed for any name
## was the server. A frame reaches its backend and many a scene's sources by
## address, so the address is checked here (OpenSSL's `X509_check_ip_asc`,
## the IP SANs), after the handshake and before a byte is sent.
##
## The check is looked up at run time rather than linked, the way std/net
## finds most of OpenSSL: in the program first (a libcrypto it was linked
## with), else in the libcrypto std/openssl loads by name (`DLLUtilName`),
## which the release toolchain opens on its own and keeps out of the
## program's symbols. Without it an address gets no TLS at all, never an
## unchecked one.
import std/[dynlib, net]
import std/openssl

when not defined(nimDisableCertificateValidation) and not defined(windows):
  type CheckIpAsc = proc (cert: PX509, address: cstring, flags: cuint): cint {.cdecl, gcsafe, raises: [].}

  var checkIpAscFound: pointer
    ## Found once and kept: a plain address, the same for every thread.

  proc checkIpAsc(): CheckIpAsc =
    {.cast(gcsafe).}:
      if checkIpAscFound.isNil:
        var found: pointer = nil
        let program = loadLib()
        if not program.isNil:
          found = program.symAddr("X509_check_ip_asc")
        if found.isNil:
          let crypto = loadLibPattern(DLLUtilName)
          if not crypto.isNil:
            found = crypto.symAddr("X509_check_ip_asc")
        checkIpAscFound = found
      cast[CheckIpAsc](checkIpAscFound)

proc wrapTlsClient*(ctx: SslContext, socket: Socket, host: string) =
  ## `ctx.wrapConnectedSocket(socket, handshakeAsClient, host)`, and for an
  ## IP literal the certificate must name that address. Raises SslError when
  ## it does not, as std/net does for a name.
  ctx.wrapConnectedSocket(socket, handshakeAsClient, host)
  when not defined(nimDisableCertificateValidation) and not defined(windows):
    if host.len > 0 and isIpAddress(host):
      let check = checkIpAsc()
      if check.isNil:
        raise newException(SslError, "Cannot check a certificate against the address " & host)
      let certificate = socket.sslHandle.SSL_get_peer_certificate()
      if certificate.isNil:
        raise newException(SslError, "No SSL certificate found.")
      let match = check(certificate, host.cstring, 0)
      X509_free(certificate)
      if match != 1:
        raise newException(SslError, "SSL certificate does not name the address " & host)
