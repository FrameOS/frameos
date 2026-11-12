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

    /// `409 link_required` (apple/native/route.ts): an account without a
    /// password is proved on the web, and the button says with what.
    @Test func linkRequiredReadsHowToProveTheAccount() {
        let account = Account(kind: .cloud, baseURL: URL(string: "http://localhost:3000")!, email: "me@example.com")
        let client = APIClient(account: account, credentials: AccountCredentials())
        let answer: JSONValue = [
            "email": "me@example.com",
            "error": "link_required",
            "methods": ["passkey": true, "password": false, "providers": ["google"]],
            "other_ways": "Google or a passkey",
        ]
        let link = AuthService.PendingLink(answer: answer, message: "Sign in once", account: account, client: client)
        #expect(link.email == "me@example.com")
        #expect(!link.hasPassword)
        #expect(link.otherWays == "Google or a passkey")

        // A cloud from before `methods`: a password, and nothing else offered.
        let older = AuthService.PendingLink(answer: ["error": "link_required"], message: "", account: account, client: client)
        #expect(older.hasPassword)
        #expect(older.otherWays == nil)
    }
}
