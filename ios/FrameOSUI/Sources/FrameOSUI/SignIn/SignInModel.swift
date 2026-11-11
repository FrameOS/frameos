import FrameOSKit
import Observation
import SwiftUI

/// The sign-in screens' state: FrameOS Cloud first (email, password, then a
/// code when the account has a second factor), a self-hosted backend below.
@Observable @MainActor
final class SignInModel {
    enum Step: Equatable { case cloud, cloudCode, backend }

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

    var cloudURL: URL? {
        let text = cloudAddress.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return Account.defaultCloudURL }
        return URL(string: text.contains("://") ? text : "https://\(text)")
    }

    var canSubmit: Bool {
        switch step {
        case .cloud: return !email.isEmpty && !password.isEmpty && cloudURL != nil
        case .cloudCode: return code.trimmingCharacters(in: .whitespaces).count >= 6
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
            case .backend:
                guard let url = ServerAddress.backendBaseURL(backendAddress) else { return }
                let (account, client) = try await AuthService.backendSignIn(baseURL: url, email: email, password: password,
                                                                             signUp: backendNeedsSignUp)
                finish(app, account, client)
            }
        } catch let failure as APIError {
            if failure.code == "sign_in_expired" {
                step = .cloud
                code = ""
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
    }
}
