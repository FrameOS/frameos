import Foundation
import Testing
@testable import FrameOSKit

/// Read-only probes of a FrameOS Cloud (a local dev server): the sign-in's
/// Origin handling and error shapes, the public store, a signed-out read.
/// Creates nothing. Skipped unless FRAMEOS_IT_CLOUD names one
/// (e.g. http://localhost:3000).
@Suite(.enabled(if: ProcessInfo.processInfo.environment["FRAMEOS_IT_CLOUD"] != nil))
struct CloudProbeTests {
    static var baseURL: URL { URL(string: ProcessInfo.processInfo.environment["FRAMEOS_IT_CLOUD"] ?? "http://localhost:3000")! }

    @Test func wrongPasswordIsInvalidCredentialsNotMissingOrigin() async throws {
        do {
            _ = try await AuthService.cloudSignIn(baseURL: Self.baseURL, email: "nobody-ios-probe@example.invalid", password: "wrong-password")
            Issue.record("signed in with a wrong password")
        } catch let error as APIError {
            #expect(error.code == "invalid_credentials", "got \(error.code): \(error.message)")
            #expect(error.message == "That email and password do not match.")
        }
    }

    @Test func signedOutReadsAre401() async throws {
        let client = APIClient(account: Account(kind: .cloud, baseURL: Self.baseURL, email: ""), credentials: AccountCredentials())
        await #expect(throws: APIError.self) { try await client.call("GET", "/api/frames") }
        do {
            _ = try await client.call("GET", "/api/frames")
        } catch let error as APIError {
            #expect(error.isUnauthorized && error.code == "login_required")
        }
    }

    @Test func publicStoreParses() async throws {
        let client = APIClient(account: Account(kind: .cloud, baseURL: Self.baseURL, email: ""), credentials: AccountCredentials())
        let service = FrameOSService(client: client)
        let page = try await service.catalog(query: "", page: 1)
        for item in page.items {
            #expect(!item.id.isEmpty && !item.name.isEmpty)
            if case .cloudStore(let id) = item.source { #expect(id == item.id) }
        }
        if let first = page.items.first, let image = first.image {
            _ = try? await client.bytes(image)
        }
    }
}
