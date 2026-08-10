## Ed25519 device identity for cloud-managed frames (docs/cloud-frames.md).
##
## The frame generates its own keypair at enrollment; the provider stores only
## the public key. The private key is a 32-byte Ed25519 seed, stored base64 in
## ./state/cloud_device_key with 0600 permissions (same atomic-write pattern as
## the cloud link state file). The keypair never leaves the device and there is
## no verb — local or remote — that reads it back out.
##
## Crypto comes from the system libcrypto via a minimal runtime-loaded EVP FFI
## (the binary already speaks TLS through OpenSSL, but Nim's -d:ssl wrapper
## does not expose the raw-key Ed25519 API, and macOS dev machines resolve
## `libcrypto.dylib` to LibreSSL builds that lack it — so the loader probes a
## candidate list for the symbols it needs instead of trusting the first
## library name that resolves).

import base64
import locks
import os
import std/dynlib
import std/sysrand
import strutils

const
  DEVICE_KEY_PATH = "./state/cloud_device_key"
  EVP_PKEY_ED25519 = cint(1087) # NID_ED25519
  Ed25519SeedLen = 32
  Ed25519PublicKeyLen = 32
  Ed25519SignatureLen = 64

type
  CloudIdentityError* = object of CatchableError

  EvpPkey = pointer
  EvpMdCtx = pointer

  NewRawKeyProc = proc(id: cint, engine: pointer, key: ptr uint8,
                       keyLen: csize_t): EvpPkey {.cdecl.}
  GetRawKeyProc = proc(pkey: EvpPkey, outKey: ptr uint8,
                       outLen: ptr csize_t): cint {.cdecl.}
  PkeyFreeProc = proc(pkey: EvpPkey) {.cdecl.}
  MdCtxNewProc = proc(): EvpMdCtx {.cdecl.}
  MdCtxFreeProc = proc(ctx: EvpMdCtx) {.cdecl.}
  DigestSignVerifyInitProc = proc(ctx: EvpMdCtx, pctx: pointer, md: pointer,
                                  engine: pointer, pkey: EvpPkey): cint {.cdecl.}
  DigestSignProc = proc(ctx: EvpMdCtx, sig: ptr uint8, sigLen: ptr csize_t,
                        tbs: ptr uint8, tbsLen: csize_t): cint {.cdecl.}
  DigestVerifyProc = proc(ctx: EvpMdCtx, sig: ptr uint8, sigLen: csize_t,
                          tbs: ptr uint8, tbsLen: csize_t): cint {.cdecl.}

var
  identityLock: Lock
  cryptoLoaded = false
  cryptoLibName = ""
  fnNewRawPrivateKey: NewRawKeyProc
  fnNewRawPublicKey: NewRawKeyProc
  fnGetRawPublicKey: GetRawKeyProc
  fnPkeyFree: PkeyFreeProc
  fnMdCtxNew: MdCtxNewProc
  fnMdCtxFree: MdCtxFreeProc
  fnDigestSignInit: DigestSignVerifyInitProc
  fnDigestVerifyInit: DigestSignVerifyInitProc
  fnDigestSign: DigestSignProc
  fnDigestVerify: DigestVerifyProc
  cachedSeed = "" ## raw 32 bytes once loaded/generated

initLock(identityLock)

proc deviceKeyPath*(): string =
  ## Overridable for tests; defaults to the 0600 state file next to
  ## cloud_link.json.
  let override = getEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH")
  if override.len > 0: override else: DEVICE_KEY_PATH

proc libcryptoCandidates(): seq[string] =
  let override = getEnv("FRAMEOS_LIBCRYPTO_PATH")
  if override.len > 0:
    result.add(override)
  when defined(macosx):
    result.add("/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib")
    result.add("/opt/homebrew/opt/openssl@1.1/lib/libcrypto.1.1.dylib")
    result.add("/usr/local/opt/openssl@3/lib/libcrypto.3.dylib")
    result.add("/usr/local/opt/openssl@1.1/lib/libcrypto.1.1.dylib")
    result.add("libcrypto.3.dylib")
    result.add("libcrypto.1.1.dylib")
    result.add("libcrypto.dylib")
  elif defined(windows):
    result.add("libcrypto-3-x64.dll")
    result.add("libcrypto-3.dll")
    result.add("libcrypto-1_1-x64.dll")
    result.add("libcrypto-1_1.dll")
  else:
    result.add("libcrypto.so.3")
    result.add("libcrypto.so.1.1")
    result.add("libcrypto.so")

proc loadCryptoLocked() =
  ## Must be called with identityLock held.
  if cryptoLoaded:
    return
  for candidate in libcryptoCandidates():
    let lib = loadLib(candidate)
    if lib == nil:
      continue
    # Probe for the one symbol LibreSSL < 3.7 lacks before committing.
    if lib.symAddr("EVP_PKEY_new_raw_private_key") == nil or
        lib.symAddr("EVP_DigestSign") == nil:
      unloadLib(lib)
      continue
    fnNewRawPrivateKey = cast[NewRawKeyProc](lib.symAddr("EVP_PKEY_new_raw_private_key"))
    fnNewRawPublicKey = cast[NewRawKeyProc](lib.symAddr("EVP_PKEY_new_raw_public_key"))
    fnGetRawPublicKey = cast[GetRawKeyProc](lib.symAddr("EVP_PKEY_get_raw_public_key"))
    fnPkeyFree = cast[PkeyFreeProc](lib.symAddr("EVP_PKEY_free"))
    fnMdCtxNew = cast[MdCtxNewProc](lib.symAddr("EVP_MD_CTX_new"))
    fnMdCtxFree = cast[MdCtxFreeProc](lib.symAddr("EVP_MD_CTX_free"))
    fnDigestSignInit = cast[DigestSignVerifyInitProc](lib.symAddr("EVP_DigestSignInit"))
    fnDigestVerifyInit = cast[DigestSignVerifyInitProc](lib.symAddr("EVP_DigestVerifyInit"))
    fnDigestSign = cast[DigestSignProc](lib.symAddr("EVP_DigestSign"))
    fnDigestVerify = cast[DigestVerifyProc](lib.symAddr("EVP_DigestVerify"))
    if fnNewRawPrivateKey.isNil or fnNewRawPublicKey.isNil or
        fnGetRawPublicKey.isNil or fnPkeyFree.isNil or fnMdCtxNew.isNil or
        fnMdCtxFree.isNil or fnDigestSignInit.isNil or fnDigestVerifyInit.isNil or
        fnDigestSign.isNil or fnDigestVerify.isNil:
      unloadLib(lib)
      continue
    cryptoLibName = candidate
    cryptoLoaded = true
    return
  raise newException(CloudIdentityError,
    "No libcrypto with Ed25519 support found (needs OpenSSL >= 1.1.1 or LibreSSL >= 3.7)")

proc writeSeedFileLocked(seed: string) =
  ## 0600 atomic write, same discipline as saveCloudLinkState: never leave a
  ## window where another local account could read the key bytes.
  let path = deviceKeyPath()
  let dir = splitFile(path).dir
  if dir.len > 0 and not dirExists(dir):
    createDir(dir)
  if dir.len > 0:
    try:
      setFilePermissions(dir, {fpUserRead, fpUserWrite, fpUserExec})
    except CatchableError:
      discard
  let tempPath = path & ".tmp"
  let handle = open(tempPath, fmWrite)
  try:
    setFilePermissions(tempPath, {fpUserRead, fpUserWrite})
    handle.write(base64.encode(seed) & "\n")
  finally:
    handle.close()
  moveFile(tempPath, path)

proc loadSeedLocked(): string =
  ## Returns the raw 32-byte seed, or "" when no key exists yet.
  if cachedSeed.len == Ed25519SeedLen:
    return cachedSeed
  let path = deviceKeyPath()
  if not fileExists(path):
    return ""
  let decoded =
    try:
      base64.decode(readFile(path).strip())
    except CatchableError:
      raise newException(CloudIdentityError, "Corrupt device key file: " & path)
  if decoded.len != Ed25519SeedLen:
    raise newException(CloudIdentityError, "Device key file has wrong length: " & path)
  cachedSeed = decoded
  cachedSeed

proc publicKeyFromSeedLocked(seed: string): string =
  ## Raw 32-byte public key for a seed. identityLock + loaded crypto required.
  var seedBytes = seed
  let pkey = fnNewRawPrivateKey(EVP_PKEY_ED25519, nil,
    cast[ptr uint8](addr seedBytes[0]), csize_t(Ed25519SeedLen))
  if pkey == nil:
    raise newException(CloudIdentityError, "EVP_PKEY_new_raw_private_key failed")
  defer: fnPkeyFree(pkey)
  var pub = newString(Ed25519PublicKeyLen)
  var pubLen = csize_t(Ed25519PublicKeyLen)
  if fnGetRawPublicKey(pkey, cast[ptr uint8](addr pub[0]), addr pubLen) != 1 or
      pubLen != csize_t(Ed25519PublicKeyLen):
    raise newException(CloudIdentityError, "EVP_PKEY_get_raw_public_key failed")
  pub

proc hasDeviceKeypair*(): bool {.gcsafe.} =
  {.gcsafe.}:
    withLock identityLock:
      result = cachedSeed.len == Ed25519SeedLen or fileExists(deviceKeyPath())

proc ensureDeviceKeypair*(): tuple[publicKeyBase64: string] {.gcsafe.} =
  ## Loads the device keypair, generating and persisting one on first use.
  ## Returns the base64 raw Ed25519 public key that gets enrolled with the
  ## provider.
  {.gcsafe.}:
    withLock identityLock:
      loadCryptoLocked()
      var seed = loadSeedLocked()
      if seed.len != Ed25519SeedLen:
        # An Ed25519 private key is 32 uniformly random bytes.
        let random = urandom(Ed25519SeedLen)
        seed = newString(Ed25519SeedLen)
        copyMem(addr seed[0], unsafeAddr random[0], Ed25519SeedLen)
        writeSeedFileLocked(seed)
        cachedSeed = seed
      result = (publicKeyBase64: base64.encode(publicKeyFromSeedLocked(seed)))

proc signBase64*(message: string): string {.gcsafe.} =
  ## Signs `message` with the device key; returns the base64 Ed25519 signature.
  ## Raises CloudIdentityError when no keypair exists yet.
  {.gcsafe.}:
    withLock identityLock:
      loadCryptoLocked()
      var seed = loadSeedLocked()
      if seed.len != Ed25519SeedLen:
        raise newException(CloudIdentityError, "No device keypair; enroll first")
      let pkey = fnNewRawPrivateKey(EVP_PKEY_ED25519, nil,
        cast[ptr uint8](addr seed[0]), csize_t(Ed25519SeedLen))
      if pkey == nil:
        raise newException(CloudIdentityError, "EVP_PKEY_new_raw_private_key failed")
      defer: fnPkeyFree(pkey)
      let ctx = fnMdCtxNew()
      if ctx == nil:
        raise newException(CloudIdentityError, "EVP_MD_CTX_new failed")
      defer: fnMdCtxFree(ctx)
      if fnDigestSignInit(ctx, nil, nil, nil, pkey) != 1:
        raise newException(CloudIdentityError, "EVP_DigestSignInit failed")
      var msg = message
      let msgPtr = if msg.len > 0: cast[ptr uint8](addr msg[0]) else: nil
      var sig = newString(Ed25519SignatureLen)
      var sigLen = csize_t(Ed25519SignatureLen)
      if fnDigestSign(ctx, cast[ptr uint8](addr sig[0]), addr sigLen,
          msgPtr, csize_t(msg.len)) != 1 or sigLen != csize_t(Ed25519SignatureLen):
        raise newException(CloudIdentityError, "EVP_DigestSign failed")
      result = base64.encode(sig)

proc verifySignatureBase64*(publicKeyBase64, message, signatureBase64: string): bool {.gcsafe.} =
  ## Verifies an Ed25519 signature against a base64 raw public key. Used by
  ## tests to prove the sign path, and available for future release-signature
  ## checks.
  var pub, sig: string
  try:
    pub = base64.decode(publicKeyBase64)
    sig = base64.decode(signatureBase64)
  except CatchableError:
    return false
  if pub.len != Ed25519PublicKeyLen or sig.len != Ed25519SignatureLen:
    return false
  {.gcsafe.}:
    withLock identityLock:
      loadCryptoLocked()
      let pkey = fnNewRawPublicKey(EVP_PKEY_ED25519, nil,
        cast[ptr uint8](addr pub[0]), csize_t(Ed25519PublicKeyLen))
      if pkey == nil:
        return false
      defer: fnPkeyFree(pkey)
      let ctx = fnMdCtxNew()
      if ctx == nil:
        return false
      defer: fnMdCtxFree(ctx)
      if fnDigestVerifyInit(ctx, nil, nil, nil, pkey) != 1:
        return false
      var msg = message
      let msgPtr = if msg.len > 0: cast[ptr uint8](addr msg[0]) else: nil
      result = fnDigestVerify(ctx, cast[ptr uint8](addr sig[0]),
        csize_t(sig.len), msgPtr, csize_t(msg.len)) == 1

proc resetDeviceIdentityCache*() {.gcsafe.} =
  ## Drops the in-memory seed cache; tests use this when switching key paths.
  {.gcsafe.}:
    withLock identityLock:
      cachedSeed = ""

proc loadedCryptoLibrary*(): string {.gcsafe.} =
  ## Diagnostic: which libcrypto the identity module bound to ("" until used).
  {.gcsafe.}:
    withLock identityLock:
      result = cryptoLibName
