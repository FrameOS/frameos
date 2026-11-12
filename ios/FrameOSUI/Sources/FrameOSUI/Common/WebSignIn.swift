import AuthenticationServices
import FrameOSKit
import SwiftUI

/// The system's sign-in sheet (ASWebAuthenticationSession, through SwiftUI's
/// `webAuthenticationSession`) for `CloudWebSignIn`. It shares Safari's
/// cookies, so someone signed in to Google there is not asked again; a cloud
/// session Safari already holds is asked about on the cloud's page first.
enum WebSignIn {
    @MainActor
    static func open(_ session: WebAuthenticationSession, _ url: URL) async throws -> URL {
        if #available(iOS 17.4, macOS 14.4, *) {
            return try await session.authenticate(using: url,
                                                  callback: .customScheme(CloudWebSignIn.callbackScheme),
                                                  preferredBrowserSession: .shared,
                                                  additionalHeaderFields: [:])
        }
        return try await session.authenticate(using: url, callbackURLScheme: CloudWebSignIn.callbackScheme,
                                              preferredBrowserSession: .shared)
    }

    /// The sheet's own Cancel, "Cancel" on the cloud's page, or a dismissed task.
    static func wasCancelled(_ error: Error) -> Bool {
        if let sheet = error as? ASWebAuthenticationSessionError, sheet.code == .canceledLogin { return true }
        if (error as? APIError)?.code == "cancelled" { return true }
        return error is CancellationError
    }
}
