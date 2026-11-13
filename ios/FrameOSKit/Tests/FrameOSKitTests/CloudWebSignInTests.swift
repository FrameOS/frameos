import Foundation
import Testing
@testable import FrameOSKit

/// The app half of the web sign-in handoff (cloud/docs/auth.md "Signing in to
/// the app"): what the sheet opens and how its answer is read.
@Suite struct CloudWebSignInTests {
    let base = URL(string: "https://cloud.frameos.net")!

    @Test func pkceIsRFC7636S256() {
        // RFC 7636, appendix B; the cloud's test (app-sign-in.test.ts) uses the same pair.
        #expect(CloudWebSignIn.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
            == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let verifier = CloudWebSignIn.randomToken()
        #expect(verifier.count == 43)
        #expect(verifier.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        #expect(CloudWebSignIn.randomToken() != verifier)
    }

    @Test func opensTheAuthorizeRouteWithItsChallenge() throws {
        let request = CloudWebSignIn(baseURL: base, provider: .google, reauth: true, verifier: "v".padding(toLength: 43, withPad: "v", startingAt: 0), state: "s1")
        let components = try #require(URLComponents(url: request.url, resolvingAgainstBaseURL: false))
        #expect(components.host == "cloud.frameos.net")
        #expect(components.path == "/api/auth/app/authorize")
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(items["code_challenge"] == CloudWebSignIn.challenge(for: request.verifier))
        #expect(items["code_challenge_method"] == "S256")
        #expect(items["state"] == "s1")
        #expect(items["provider"] == "google")
        #expect(items["reauth"] == "1")
        // The verifier itself never leaves the app until the token exchange.
        #expect(!request.url.absoluteString.contains(request.verifier))

        let plain = CloudWebSignIn(baseURL: URL(string: "http://localhost:3000")!)
        let plainItems = URLComponents(url: plain.url, resolvingAgainstBaseURL: false)?.queryItems?.map(\.name) ?? []
        #expect(plain.url.port == 3000)
        #expect(!plainItems.contains("provider") && !plainItems.contains("reauth"))
    }

    @Test func readsTheCallback() throws {
        let request = CloudWebSignIn(baseURL: base, state: "s1")
        #expect(try request.code(from: URL(string: "frameos://sign-in?code=abc.def&state=s1")!) == "abc.def")

        func failure(_ url: String) -> String? {
            do {
                _ = try request.code(from: URL(string: url)!)
                return nil
            } catch let error as APIError {
                return error.code
            } catch {
                return "?"
            }
        }
        #expect(failure("frameos://sign-in?code=abc&state=other") == "invalid_state")
        #expect(failure("frameos://sign-in?code=abc") == "invalid_state")
        #expect(failure("https://evil.example/sign-in?code=abc&state=s1") == "invalid_state")
        #expect(failure("frameos://sign-in?error=access_denied&state=s1") == "cancelled")
        #expect(failure("frameos://sign-in?error=invalid_request&state=s1") == "invalid_request")
        #expect(failure("frameos://sign-in?state=s1") == "invalid_grant")
    }
}
