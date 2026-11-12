import AuthenticationServices
import FrameOSKit
import Observation
import SwiftUI

/// The sign-in screens' state: FrameOS Cloud first (email, password, then a
/// code when the account has a second factor), a self-hosted backend below.
@Observable @MainActor
final class SignInModel {
    /// `cloudLink`: Sign in with Apple matched an account with a password,
    /// which is asked for once to connect the two.
    enum Step: Equatable { case cloud, cloudCode, cloudLink, backend }

    var step: Step = .cloud
    var email = ""
    var password = ""
    var code = ""
    var cloudAddress = Account.defaultCloudURL.absoluteString
    var showCloudAddress = false
    var backendAddress = ""
    var backendNeedsSignUp = false
    var busy = false
    var error: String?

    private var pending: AuthService.PendingCloudSignIn?
    private(set) var link: AuthService.PendingLink?
    /// The nonce of the Apple request in flight (AppleSignIn).
    private var appleNonce: String?

    var cloudURL: URL? {
        let text = cloudAddress.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return Account.defaultCloudURL }
        return URL(string: text.contains("://") ? text : "https://\(text)")
    }

    var canSubmit: Bool {
        switch step {
        case .cloud: return !email.isEmpty && !password.isEmpty && cloudURL != nil
        case .cloudCode: return code.trimmingCharacters(in: .whitespaces).count >= 6
        case .cloudLink: return !password.isEmpty && link != nil
        case .backend: return !email.isEmpty && password.count >= (backendNeedsSignUp ? 8 : 1)
            && ServerAddress.backendBaseURL(backendAddress) != nil
        }
    }

    func submit(app: AppModel) async {
        guard canSubmit, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            switch step {
            case .cloud:
                guard let url = cloudURL else { return }
                switch try await AuthService.cloudSignIn(baseURL: url, email: email, password: password) {
                case .signedIn(let account, let client):
                    finish(app, account, client)
                case .secondFactor(let pending):
                    self.pending = pending
                    step = .cloudCode
                }
            case .cloudCode:
                guard let pending else { step = .cloud; return }
                let (account, client) = try await AuthService.cloudSecondFactor(pending, code: code)
                finish(app, account, client)
            case .cloudLink:
                guard let link else { step = .cloud; return }
                switch try await AuthService.cloudLink(link, password: password) {
                case .signedIn(let account, let client):
                    finish(app, account, client)
                case .secondFactor(let pending):
                    self.pending = pending
                    password = ""
                    step = .cloudCode
                }
            case .backend:
                guard let url = ServerAddress.backendBaseURL(backendAddress) else { return }
                let (account, client) = try await AuthService.backendSignIn(baseURL: url, email: email, password: password,
                                                                             signUp: backendNeedsSignUp)
                finish(app, account, client)
            }
        } catch let failure as APIError {
            if failure.code == "sign_in_expired" || failure.code == "link_expired" {
                step = .cloud
                code = ""
                link = nil
            }
            error = failure.message
        } catch let failure as URLError {
            error = failure.code == .cannotFindHost || failure.code == .cannotConnectToHost
                ? "Cannot reach \(step == .backend ? "that backend" : "FrameOS Cloud"). Check the address and your network."
                : failure.localizedDescription
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Google, a passkey, or any sign-in the web has, through the system's
    /// sign-in sheet (`open` runs it and returns where the cloud sent it back).
    func signInOnWeb(app: AppModel, provider: CloudWebSignIn.Provider?,
                     open: (URL) async throws -> URL) async
    {
        guard let url = cloudURL, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        let request = CloudWebSignIn(baseURL: url, provider: provider)
        do {
            let callback = try await open(request.url)
            let (account, client) = try await AuthService.cloudFinishWebSignIn(request, callback: callback)
            finish(app, account, client)
        } catch let failure where WebSignIn.wasCancelled(failure) {
            // The sheet's Cancel, or "Cancel" on the cloud's page: nothing to say.
        } catch let failure as URLError {
            error = failure.code == .cannotFindHost || failure.code == .cannotConnectToHost
                ? "Cannot reach FrameOS Cloud. Check the address and your network."
                : failure.localizedDescription
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The Apple request: name and email, and this attempt's nonce, hashed.
    func prepareApple(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = AppleSignIn.makeNonce()
        appleNonce = nonce
        request.requestedScopes = [.fullName, .email]
        request.nonce = AppleSignIn.hash(nonce)
    }

    /// The system sheet's answer, posted to the cloud (`/api/auth/apple/native`).
    func signInWithApple(app: AppModel, result: Result<ASAuthorization, Error>) async {
        guard let url = cloudURL, !busy else { return }
        let nonce = appleNonce
        appleNonce = nil
        let authorization: ASAuthorization
        switch result {
        case .failure(let failure):
            if (failure as? ASAuthorizationError)?.code == .canceled { return }
            error = failure.localizedDescription
            return
        case .success(let value):
            authorization = value
        }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken, let token = String(data: tokenData, encoding: .utf8),
              let codeData = credential.authorizationCode, let code = String(data: codeData, encoding: .utf8),
              let nonce
        else {
            error = "Apple did not finish the sign-in. Try again."
            return
        }
        busy = true
        error = nil
        defer { busy = false }
        do {
            switch try await AuthService.cloudSignInWithApple(
                baseURL: url, identityToken: token, authorizationCode: code, nonce: nonce,
                givenName: credential.fullName?.givenName, familyName: credential.fullName?.familyName)
            {
            case .signedIn(let account, let client):
                finish(app, account, client)
            case .secondFactor(let pending):
                self.pending = pending
                step = .cloudCode
            case .linkRequired(let link):
                self.link = link
                email = link.email
                password = ""
                step = .cloudLink
            }
        } catch let failure as URLError {
            error = failure.code == .cannotFindHost || failure.code == .cannotConnectToHost
                ? "Cannot reach FrameOS Cloud. Check the address and your network."
                : failure.localizedDescription
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A backend with no account yet offers to create the first one.
    func checkBackend() async {
        guard let url = ServerAddress.backendBaseURL(backendAddress) else { return }
        if let hasUser = try? await AuthService.backendHasFirstUser(baseURL: url) {
            backendNeedsSignUp = !hasUser
        }
    }

    private func finish(_ app: AppModel, _ account: Account, _ client: APIClient) {
        password = ""
        code = ""
        pending = nil
        link = nil
        app.add(account, client: client)
    }

    func useBackend() {
        step = .backend
        error = nil
    }

    func useCloud() {
        step = .cloud
        error = nil
        code = ""
        link = nil
    }
}
