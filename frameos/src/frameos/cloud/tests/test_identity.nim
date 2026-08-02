import std/[base64, os, strutils, times, unittest]

import ../identity

let keyDir = getTempDir() / ("frameos-test-identity-" & $(epochTime().int64) & "-" & $getCurrentProcessId())
createDir(keyDir)
let keyPath = keyDir / "cloud_device_key"
putEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH", keyPath)

suite "cloud device identity":
  test "keypair generation persists a 0600 seed file":
    resetDeviceIdentityCache()
    check not hasDeviceKeypair()
    let (publicKeyBase64) = ensureDeviceKeypair()
    check hasDeviceKeypair()
    check fileExists(keyPath)
    check base64.decode(publicKeyBase64).len == 32
    when not defined(windows):
      let permissions = getFilePermissions(keyPath)
      check fpUserRead in permissions
      check fpUserWrite in permissions
      for other in [fpGroupRead, fpGroupWrite, fpGroupExec,
                    fpOthersRead, fpOthersWrite, fpOthersExec]:
        check other notin permissions
    # Seed file is base64 of exactly 32 bytes.
    check base64.decode(readFile(keyPath).strip()).len == 32

  test "sign/verify roundtrip":
    let (publicKeyBase64) = ensureDeviceKeypair()
    let message = "nonce-" & $epochTime()
    let signature = signBase64(message)
    check base64.decode(signature).len == 64
    check verifySignatureBase64(publicKeyBase64, message, signature)
    # Tampered message, tampered signature and wrong key must all fail.
    check not verifySignatureBase64(publicKeyBase64, message & "x", signature)
    var tampered = base64.decode(signature)
    tampered[0] = char(uint8(tampered[0]) xor 0xff'u8)
    check not verifySignatureBase64(publicKeyBase64, message, base64.encode(tampered))
    check not verifySignatureBase64(base64.encode('\0'.repeat(32)), message, signature)

  test "keypair is stable across cache reload":
    let (before) = ensureDeviceKeypair()
    resetDeviceIdentityCache()
    let (after) = ensureDeviceKeypair()
    check before == after
    # And a signature made after the reload still verifies with the old key.
    check verifySignatureBase64(before, "stable", signBase64("stable"))

  test "signing without a keypair fails cleanly":
    resetDeviceIdentityCache()
    putEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH", keyDir / "missing_key")
    defer:
      putEnv("FRAMEOS_CLOUD_DEVICE_KEY_PATH", keyPath)
      resetDeviceIdentityCache()
    expect CloudIdentityError:
      discard signBase64("message")

removeDir(keyDir)
