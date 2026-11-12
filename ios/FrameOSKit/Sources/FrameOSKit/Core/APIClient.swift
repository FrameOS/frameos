import Foundation

/// The app's one transport boundary, the counterpart of the SPA's `apiFetch`
/// (frontend/src/utils/apiFetch.ts + projectApi.ts). Feature code calls
/// canonical `/api/...` paths; this decides what each plane needs on the wire:
///
/// - a backend scopes the project paths (`/api/frames/1` →
///   `/api/projects/{p}/frames/1`, `ApiPaths.isProjectScoped`, pinned to the
///   SPA's `isProjectScopedApiPath` by docs/api-path-fixtures.json) and takes
///   `Authorization: Bearer`;
/// - the cloud takes its session cookie, and every write carries the app
///   origin in `Origin` (the cloud's CSRF check, `src/lib/csrf.ts`).
///
/// One URLSession per account, with its own cookie jar, so two accounts never
/// share a cookie; the jar is mirrored into the Keychain after every response.
public final class APIClient: @unchecked Sendable {
    public let account: Account
    public let session: URLSession
    private let lock = NSLock()
    private var credentials: AccountCredentials
    private var lastSavedCookies: [StoredCookie] = []
    /// Called (on any thread) when the plane says the credentials are no longer good.
    public var onUnauthorized: (@Sendable () -> Void)?

    public init(account: Account, credentials: AccountCredentials) {
        self.account = account
        self.credentials = credentials
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 15 * 60
        configuration.waitsForConnectivity = false
        configuration.httpAdditionalHeaders = ["User-Agent": APIClient.userAgent]
        let storage = configuration.httpCookieStorage ?? HTTPCookieStorage()
        for cookie in credentials.cookies {
            if let httpCookie = cookie.httpCookie { storage.setCookie(httpCookie) }
        }
        self.lastSavedCookies = credentials.cookies
        self.session = URLSession(configuration: configuration)
    }

    public static var userAgent: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        return "FrameOS-iOS/\(version)"
    }

    public var kind: PlaneKind { account.kind }

    public var currentCredentials: AccountCredentials {
        lock.lock(); defer { lock.unlock() }
        return credentials
    }

    public func updateCredentials(_ change: (inout AccountCredentials) -> Void) {
        lock.lock()
        change(&credentials)
        let snapshot = credentials
        lock.unlock()
        snapshot.save(accountId: account.id)
    }

    // MARK: paths

    /// The wire path for a canonical one (the SPA's projectApiPathForProject).
    public func resolve(_ path: String) -> String {
        guard account.kind == .backend, let projectId = account.projectId, ApiPaths.isProjectScoped(path) else {
            return path
        }
        return "/api/projects/\(projectId)" + path.dropFirst("/api".count)
    }

    public func url(_ path: String, query: [String: String?] = [:]) -> URL {
        let wire = resolve(path)
        var components = URLComponents(url: account.baseURL, resolvingAgainstBaseURL: false)!
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        // Paths may carry their own query (`/api/x?y=1`): split it off first.
        let pieces = wire.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        components.percentEncodedPath = basePath + ApiPaths.encodeWirePath(String(pieces[0]))
        var items: [URLQueryItem] = []
        if pieces.count == 2 {
            items += URLComponents(string: "?" + pieces[1])?.queryItems ?? []
        }
        for (name, value) in query.sorted(by: { $0.key < $1.key }) {
            if let value { items.append(URLQueryItem(name: name, value: value)) }
        }
        components.queryItems = items.isEmpty ? nil : items
        // `+` in a query value means a space to most servers: encode it.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url!
    }

    // MARK: requests

    public enum Body {
        case none
        case json(JSONValue)
        case data(Data, contentType: String)
        case form([String: String])
        case multipart([MultipartPart])
    }

    public struct MultipartPart {
        public var name: String
        public var filename: String?
        public var contentType: String?
        public var data: Data
        public init(name: String, filename: String? = nil, contentType: String? = nil, data: Data) {
            self.name = name
            self.filename = filename
            self.contentType = contentType
            self.data = data
        }
        public static func field(_ name: String, _ value: String) -> MultipartPart {
            MultipartPart(name: name, data: Data(value.utf8))
        }
    }

    public func request(_ method: String, _ path: String, query: [String: String?] = [:], body: Body = .none,
                        timeout: TimeInterval = 60, accept: String = "application/json") -> URLRequest
    {
        var request = URLRequest(url: url(path, query: query), timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue(accept, forHTTPHeaderField: "Accept")
        authorize(&request, isWrite: method != "GET" && method != "HEAD")
        switch body {
        case .none:
            break
        case .json(let value):
            // Exactly `application/json`: the backend's event route reads the
            // body as JSON only then (app/api/frames.py).
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(value.jsonString().utf8)
        case .data(let data, let contentType):
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = data
        case .form(let fields):
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(ApiPaths.formEncode(fields).utf8)
        case .multipart(let parts):
            let boundary = "frameos-\(UUID().uuidString)"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.httpBody = ApiPaths.multipartBody(parts, boundary: boundary)
        }
        return request
    }

    /// Credentials for one request: a backend's bearer, the cloud's Origin.
    public func authorize(_ request: inout URLRequest, isWrite: Bool) {
        switch account.kind {
        case .backend:
            if let bearer = currentCredentials.bearer, !bearer.isEmpty {
                request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            }
        case .cloud:
            // Harmless on reads, required on writes with the session cookie.
            request.setValue(account.origin, forHTTPHeaderField: "Origin")
        }
    }

    /// Sends a request, raising `APIError` on a non-2xx answer.
    @discardableResult
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, message: "No answer from \(account.planeLabel).")
        }
        persistCookiesIfChanged()
        if !(200..<300).contains(http.statusCode) {
            let error = APIError.from(status: http.statusCode, data: data, headers: http.allHeaderFields)
            if error.isUnauthorized { onUnauthorized?() }
            throw error
        }
        return (data, http)
    }

    @discardableResult
    public func call(_ method: String, _ path: String, query: [String: String?] = [:], body: Body = .none,
                     timeout: TimeInterval = 60) async throws -> JSONValue
    {
        let (data, _) = try await send(request(method, path, query: query, body: body, timeout: timeout))
        if data.isEmpty { return .null }
        return (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .string(String(decoding: data, as: UTF8.self))
    }

    public func get(_ path: String, query: [String: String?] = [:], timeout: TimeInterval = 60) async throws -> JSONValue {
        try await call("GET", path, query: query, timeout: timeout)
    }

    public func decode<T: Decodable>(_ type: T.Type, _ method: String = "GET", _ path: String,
                                     query: [String: String?] = [:], body: Body = .none) async throws -> T
    {
        let (data, _) = try await send(request(method, path, query: query, body: body))
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The bytes of a binary route (images, asset files).
    public func bytes(_ path: String, query: [String: String?] = [:], timeout: TimeInterval = 60) async throws -> (Data, HTTPURLResponse) {
        try await send(request("GET", path, query: query, timeout: timeout, accept: "*/*"))
    }

    /// An NDJSON stream (the AI chat): one JSON object per line, in order.
    public func lines(_ method: String, _ path: String, query: [String: String?] = [:], body: Body = .none) -> AsyncThrowingStream<JSONValue, Error> {
        let request = self.request(method, path, query: query, body: body, timeout: 15 * 60, accept: "application/x-ndjson")
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw APIError(status: 0, message: "No answer from \(account.planeLabel).")
                    }
                    if !(200..<300).contains(http.statusCode) {
                        var data = Data()
                        for try await byte in bytes { data.append(byte) }
                        let error = APIError.from(status: http.statusCode, data: data, headers: http.allHeaderFields)
                        if error.isUnauthorized { onUnauthorized?() }
                        throw error
                    }
                    for try await line in bytes.lines {
                        let trimmed = line.trimmingCharacters(in: .whitespaces)
                        if trimmed.isEmpty { continue }
                        if let value = try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed.utf8)) {
                            continuation.yield(value)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The plane's live socket: the cloud hub's `/api/frames/updates`, a
    /// backend's `/ws`. Both authenticate with the session cookie alone.
    public func webSocket() -> URLSessionWebSocketTask {
        var components = URLComponents(url: account.baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + (account.kind == .cloud ? "/api/frames/updates" : "/ws")
        var request = URLRequest(url: components.url!)
        request.setValue(APIClient.userAgent, forHTTPHeaderField: "User-Agent")
        if account.kind == .cloud {
            request.setValue(account.origin, forHTTPHeaderField: "Origin")
        }
        // A backend checks an Origin it is sent against its Host; send none.
        return session.webSocketTask(with: request)
    }

    // MARK: cookies

    public func cookies() -> [HTTPCookie] {
        session.configuration.httpCookieStorage?.cookies ?? []
    }

    func persistCookiesIfChanged() {
        let current = cookies().filter { cookie in
            // Short-lived sign-in helpers stay in memory.
            cookie.name != "frameos_signin_pending" && cookie.name != "frameos_webauthn_challenge"
        }.map(StoredCookie.init).sorted { $0.name < $1.name }
        lock.lock()
        let changed = current != lastSavedCookies
        if changed {
            lastSavedCookies = current
            credentials.cookies = current
        }
        let snapshot = credentials
        lock.unlock()
        if changed { snapshot.save(accountId: account.id) }
    }

    public func clearCookies() {
        let storage = session.configuration.httpCookieStorage
        for cookie in storage?.cookies ?? [] { storage?.deleteCookie(cookie) }
        persistCookiesIfChanged()
    }
}

/// Path rules shared by both planes.
public enum ApiPaths {
    /// The SPA's `isProjectScopedApiPath` (frontend/src/utils/projectApi.ts),
    /// pinned to it by docs/api-path-fixtures.json.
    public static func isProjectScoped(_ path: String) -> Bool {
        if !path.hasPrefix("/api/") || path.hasPrefix("/api/projects/") { return false }
        let bare = ["/api/login", "/api/logout", "/api/signup", "/api/has_first_user", "/api/user",
                    "/api/cloud", "/api/generate_ssh_keys", "/api/log"]
        if bare.contains(path) || path.hasPrefix("/api/user/") || path.hasPrefix("/api/system/")
            || path.hasPrefix("/api/cloud/")
        {
            return false
        }
        let prefixes = ["/api/ai", "/api/apps", "/api/assets", "/api/fonts", "/api/frame-bootstrap", "/api/frames",
                        "/api/photos", "/api/repositories", "/api/settings", "/api/templates"]
        return prefixes.contains { prefix in
            path == prefix || path.hasPrefix(prefix + "/") || path.hasPrefix(prefix + "?")
        }
    }

    /// Percent-encodes each segment of a path, keeping its slashes (scene
    /// ids like `system/index` are a path on both planes' scene-image routes).
    public static func encodePath(_ path: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "?#;%")
        return path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
    }

    /// The last step before the wire: what a caller left raw is encoded,
    /// what it already encoded (`segment`, `encodePath`) is kept as it is.
    static func encodeWirePath(_ path: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "?#;")
        allowed.insert(charactersIn: "%")
        return path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
    }

    /// One path segment, slashes encoded too.
    public static func segment(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#;%")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    static func formEncode(_ fields: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return fields.sorted { $0.key < $1.key }.map { key, value in
            "\(key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value)"
        }.joined(separator: "&")
    }

    static func multipartBody(_ parts: [APIClient.MultipartPart], boundary: String) -> Data {
        var body = Data()
        for part in parts {
            body.append(Data("--\(boundary)\r\n".utf8))
            var disposition = "Content-Disposition: form-data; name=\"\(part.name)\""
            if let filename = part.filename {
                disposition += "; filename=\"\(filename.replacingOccurrences(of: "\"", with: "_"))\""
            }
            body.append(Data("\(disposition)\r\n".utf8))
            if let contentType = part.contentType {
                body.append(Data("Content-Type: \(contentType)\r\n".utf8))
            }
            body.append(Data("\r\n".utf8))
            body.append(part.data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }
}
