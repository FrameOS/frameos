import Foundation

/// Signing in and out of either plane, with the routes the web sign-in pages
/// use (cloud: app/api/auth/*, cloud/docs/auth.md; backend: app/api/auth.py).
public enum AuthService {
    public enum CloudStep: Sendable {
        /// Signed in: the account and the client that holds its cookie.
        case signedIn(Account, APIClient)
        /// The account has a second factor: ask for the code, then `cloudSecondFactor`.
        case secondFactor(PendingCloudSignIn)
    }

    /// A cloud sign-in waiting for its TOTP or recovery code. The client holds
    /// the short-lived `frameos_signin_pending` cookie the code is checked against.
    public struct PendingCloudSignIn: @unchecked Sendable {
        public let account: Account
        public let client: APIClient
    }

    /// `POST /api/auth/login {email, password}`.
    public static func cloudSignIn(baseURL: URL, email: String, password: String) async throws -> CloudStep {
        let draft = Account(kind: .cloud, baseURL: baseURL, email: email.trimmingCharacters(in: .whitespaces))
        let client = APIClient(account: draft, credentials: AccountCredentials())
        let answer = try await client.call("POST", "/api/auth/login", body: .json([
            "email": .string(draft.email), "password": .string(password),
        ]))
        if answer["second_factor_required"]?.boolValue == true {
            return .secondFactor(PendingCloudSignIn(account: draft, client: client))
        }
        return .signedIn(try await finishCloud(draft, client), client)
    }

    /// `POST /api/auth/second-factor/code {code}` (a TOTP or a recovery code).
    public static func cloudSecondFactor(_ pending: PendingCloudSignIn, code: String) async throws -> (Account, APIClient) {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        try await pending.client.call("POST", "/api/auth/second-factor/code", body: .json(["code": .string(trimmed)]))
        return (try await finishCloud(pending.account, pending.client), pending.client)
    }

    static func finishCloud(_ draft: Account, _ client: APIClient) async throws -> Account {
        // Who am I: the light probe, and proof the cookie took.
        let security = try await client.get("/api/account/security")
        var account = draft
        if let email = security["email"]?.stringValue, !email.isEmpty { account.email = email }
        client.persistCookiesIfChanged()
        var credentials = client.currentCredentials
        credentials.cookies = client.cookies().filter { $0.name != "frameos_signin_pending" }.map(StoredCookie.init)
        credentials.save(accountId: account.id)
        return account
    }

    /// The backend's first-run question: is there an account to sign in to yet?
    public static func backendHasFirstUser(baseURL: URL) async throws -> Bool {
        let probe = APIClient(account: Account(kind: .backend, baseURL: baseURL, email: ""), credentials: AccountCredentials())
        let answer = try await probe.get("/api/has_first_user", timeout: 20)
        return answer["has_first_user"]?.boolValue ?? true
    }

    /// `POST /api/login` (an OAuth2 password form), then the project, then a
    /// long-lived API token so the phone stays signed in past the JWT's seven
    /// days. The `frameos_session` cookie from the login is kept for `/ws`.
    public static func backendSignIn(baseURL: URL, email: String, password: String, signUp: Bool = false) async throws -> (Account, APIClient) {
        let draft = Account(kind: .backend, baseURL: baseURL, email: email.trimmingCharacters(in: .whitespaces))
        let client = APIClient(account: draft, credentials: AccountCredentials())
        let answer: JSONValue
        if signUp {
            answer = try await client.call("POST", "/api/signup", body: .json([
                "email": .string(draft.email), "password": .string(password), "password2": .string(password),
                "newsletter": false,
            ]))
        } else {
            answer = try await client.call("POST", "/api/login", body: .form([
                "username": draft.email, "password": password, "grant_type": "password",
            ]))
        }
        guard let jwt = answer["access_token"]?.stringValue, !jwt.isEmpty else {
            throw APIError(status: 0, message: "The backend did not hand out a sign-in token.")
        }
        client.updateCredentials { $0.bearer = jwt }

        let projects = try await client.get("/api/projects")
        guard let projectId = projects["projects"]?.arrayValue?.first?["id"]?.intValue else {
            throw APIError(status: 0, message: "This backend has no project to open.")
        }
        var account = draft
        account.projectId = projectId
        let scoped = APIClient(account: account, credentials: client.currentCredentials)
        // Carry the login's cookie (the socket's credential) over.
        for cookie in client.cookies() { scoped.session.configuration.httpCookieStorage?.setCookie(cookie) }
        scoped.persistCookiesIfChanged()
        scoped.updateCredentials { $0.cookies = client.cookies().map(StoredCookie.init) }

        // A year-long token, so a week without the app does not sign it out.
        // A backend that refuses (an older one, a policy) keeps the JWT.
        if let token = try? await scoped.call("POST", "/api/user/api_tokens", body: .json([
            "name": .string(deviceTokenName()), "access": "full", "expires_in_days": 365,
            "current_password": .string(password),
        ])), let secret = token["token"]?.stringValue, secret.hasPrefix("fb_api") {
            let tokenId = token["api_token"]?["id"]?.stringValue
            scoped.updateCredentials {
                $0.bearer = secret
                $0.apiTokenId = tokenId
            }
        }
        if let user = try? await scoped.get("/api/user"), let email = user["email"]?.stringValue, !email.isEmpty {
            account.email = email
        }
        let final = APIClient(account: account, credentials: scoped.currentCredentials)
        for cookie in scoped.cookies() { final.session.configuration.httpCookieStorage?.setCookie(cookie) }
        final.currentCredentials.save(accountId: account.id)
        return (account, final)
    }

    static func deviceTokenName() -> String {
        #if os(iOS)
        return "FrameOS iOS app"
        #else
        return "FrameOS app"
        #endif
    }

    /// Ends the session on the plane (best effort) and forgets the credentials.
    public static func signOut(_ client: APIClient) async {
        switch client.kind {
        case .cloud:
            var request = client.request("POST", "/api/auth/logout")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            _ = try? await client.session.data(for: request)
        case .backend:
            // The login session first (the socket's cookie), while the token
            // still opens the route; then the token itself.
            _ = try? await client.call("POST", "/api/logout")
            if let tokenId = client.currentCredentials.apiTokenId {
                _ = try? await client.call("DELETE", "/api/user/api_tokens/\(ApiPaths.segment(tokenId))")
            }
        }
        client.clearCookies()
        AccountCredentials.delete(accountId: client.account.id)
    }

    /// The cloud's sudo mode (`403 reauth_required`): prove it is you again.
    public static func cloudReauth(_ client: APIClient, password: String?, code: String?) async throws {
        var body: [String: JSONValue] = [:]
        if let code, !code.isEmpty { body["code"] = .string(code) }
        else if let password { body["password"] = .string(password) }
        try await client.call("POST", "/api/auth/reauth", body: .json(.object(body)))
    }
}
