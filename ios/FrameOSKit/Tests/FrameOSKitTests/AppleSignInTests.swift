import Foundation
import Testing
@testable import FrameOSKit

/// The app half of Sign in with Apple (cloud/docs/auth.md "Sign in with
/// Apple"): the nonce Apple gets is the one the cloud recomputes.
@Suite struct AppleSignInTests {
    @Test func nonceHashIsTheCloudsSHA256Hex() {
        // The same vector as the cloud's apple-sign-in.test.ts.
        #expect(AppleSignIn.hash("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test func noncesFitWhatTheCloudTakes() {
        // apple-sign-in.ts validAppleNonce: 16 to 128 of [A-Za-z0-9._~-].
        let nonce = AppleSignIn.makeNonce()
        #expect((16...128).contains(nonce.count))
        #expect(nonce.allSatisfy { $0.isLetter || $0.isNumber || "._~-".contains($0) })
        #expect(AppleSignIn.makeNonce() != nonce)
    }
}
