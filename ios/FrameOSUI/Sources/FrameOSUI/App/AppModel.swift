import FrameOSKit
import Observation
import SwiftUI

/// A short message at the bottom of the screen after an action.
struct Notice: Identifiable, Equatable {
    enum Tone { case info, success, failure }
    let id = UUID()
    var text: String
    var tone: Tone
}

/// The app's state: the signed-in accounts, the one shown, its frames and
/// the live socket that keeps them current. Screens keep their own state in
/// their own models (the SPA's kea logics); this holds what they share.
@Observable @MainActor
final class AppModel {
    private(set) var accounts: [Account] = []
    private(set) var current: Account?
    private(set) var service: FrameOSService?
    private(set) var restoring = true

    var frames: [Frame] = []
    var framesLoading = false
    var framesError: String?
    var framesLoadedAt: Date?

    var notice: Notice?
    /// The cloud asked for a recent sign-in; the sheet retries the action after.
    var reauth: ReauthRequest?
    /// The plane said the sign-in is no longer good.
    var signedOutAccount: Account?

    /// Every new log line and metrics sample, for the screens that show them.
    let logBus = LogBus()
    /// Bumped when a frame's picture changes, keyed by frame id.
    var imageVersions: [String: Int] = [:]

    private var live: LiveUpdates?
    private var pollTask: Task<Void, Never>?
    private var clients: [String: APIClient] = [:]

    init() {}

    // MARK: accounts

    func restore() async {
        if ProcessInfo.processInfo.arguments.contains("-FrameOSUITesting") {
            // The UI tests (ios/FrameOSUITests) start signed out every time.
            for account in AccountList.load() { AccountCredentials.delete(accountId: account.id) }
            AccountList.save([])
            AccountList.setCurrentId(nil)
        }
        accounts = AccountList.load()
        let currentId = AccountList.currentId()
        let account = accounts.first { $0.id == currentId } ?? accounts.first
        if let account { activate(account) }
        restoring = false
    }

    func client(for account: Account) -> APIClient {
        if let existing = clients[account.id] { return existing }
        let client = APIClient(account: account, credentials: AccountCredentials.load(accountId: account.id) ?? AccountCredentials())
        let accountId = account.id
        client.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.handleUnauthorized(accountId) }
        }
        clients[account.id] = client
        return client
    }

    func activate(_ account: Account) {
        stopLive()
        current = account
        service = FrameOSService(client: client(for: account))
        AccountList.setCurrentId(account.id)
        frames = []
        framesError = nil
        framesLoadedAt = nil
        startLive()
        Task { await refreshFrames() }
    }

    /// A sign-in finished: keep the account (replacing one for the same
    /// plane and email) and show it.
    func add(_ account: Account, client: APIClient) {
        let duplicate = accounts.first { $0.kind == account.kind && $0.baseURL == account.baseURL && $0.email == account.email }
        if let duplicate {
            accounts.removeAll { $0.id == duplicate.id }
            clients[duplicate.id] = nil
            if duplicate.id != account.id { AccountCredentials.delete(accountId: duplicate.id) }
        }
        accounts.append(account)
        AccountList.save(accounts)
        let accountId = account.id
        client.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.handleUnauthorized(accountId) }
        }
        clients[account.id] = client
        signedOutAccount = nil
        activate(account)
    }

    /// A fresher session for an account the app already holds (confirmed
    /// through the web, CloudWebSignIn with reauth): it replaces the old one,
    /// which is signed out on the cloud.
    func adoptSession(_ client: APIClient, for account: Account) async {
        let old = clients[account.id]
        let accountId = account.id
        client.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.handleUnauthorized(accountId) }
        }
        clients[account.id] = client
        if current?.id == account.id {
            stopLive()
            service = FrameOSService(client: client)
            startLive()
        }
        if let old, old !== client { await AuthService.endCloudSession(old) }
    }

    func signOut(_ account: Account) async {
        let client = client(for: account)
        if current?.id == account.id { stopLive() }
        await AuthService.signOut(client)
        forget(account)
    }

    /// The cloud deleted the account (Settings → Delete account): its
    /// session went with it, so only the app's copy is left to forget.
    func accountDeleted(_ account: Account) {
        if current?.id == account.id { stopLive() }
        forget(account)
    }

    private func forget(_ account: Account) {
        accounts.removeAll { $0.id == account.id }
        clients[account.id] = nil
        AccountCredentials.delete(accountId: account.id)
        AccountList.save(accounts)
        if current?.id == account.id {
            current = nil
            service = nil
            frames = []
            if let next = accounts.first { activate(next) } else { AccountList.setCurrentId(nil) }
        }
    }

    private func handleUnauthorized(_ accountId: String) {
        guard let account = accounts.first(where: { $0.id == accountId }) else { return }
        signedOutAccount = account
        forget(account)
        notice = Notice(text: "Signed out of \(account.planeLabel). Sign in again.", tone: .failure)
    }

    // MARK: frames

    func refreshFrames() async {
        guard let service else { return }
        framesLoading = true
        defer { framesLoading = false }
        do {
            let list = try await service.frames()
            frames = list
            framesError = nil
            framesLoadedAt = Date()
        } catch {
            if (error as? APIError)?.isUnauthorized != true { framesError = error.localizedDescription }
        }
    }

    func frame(_ id: String) -> Frame? { frames.first { $0.id == id } }

    func replace(_ frame: Frame) {
        if let index = frames.firstIndex(where: { $0.id == frame.id }) {
            frames[index] = frame
        } else {
            frames.append(frame)
        }
    }

    func reloadFrame(_ id: String) async {
        guard let service, let fresh = try? await service.frame(id) else { return }
        replace(fresh)
    }

    // MARK: live updates

    private func startLive() {
        guard let service else { return }
        let live = LiveUpdates(client: service.client) { [weak self] event in
            Task { @MainActor in self?.apply(event) }
        }
        self.live = live
        live.start()
        // The SPA polls the frame list every 15 s on the cloud; a socket
        // that is down (or a backend whose login cookie expired) falls back
        // to the same. With the socket up this costs one list a minute.
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                let connected = self?.live?.isConnected ?? false
                try? await Task.sleep(nanoseconds: (connected ? 60 : 15) * 1_000_000_000)
                if Task.isCancelled { break }
                await self?.refreshFrames()
            }
        }
    }

    private func stopLive() {
        live?.stop()
        live = nil
        pollTask?.cancel()
        pollTask = nil
    }

    func pauseLive() { stopLive() }

    func resumeLive() {
        guard live == nil, service != nil else { return }
        startLive()
        Task { await refreshFrames() }
    }

    private func apply(_ event: LiveEvent) {
        switch event {
        case .connected:
            Task { await refreshFrames() }
        case .updateFrame(let patch), .newFrame(let patch):
            guard let id = patch["id"]?.stringValue else { return }
            if let index = frames.firstIndex(where: { $0.id == id }) {
                var merged = frames[index].raw
                for (key, value) in patch { merged[key] = value }
                frames[index] = Frame(raw: merged)
            } else if patch["name"] != nil {
                frames.append(Frame(raw: patch))
            }
        case .deleteFrame(let id):
            frames.removeAll { $0.id == id }
        case .newLog(let line):
            logBus.publish(line)
            if line.event == "render:done" { imageVersions[line.frameId, default: 0] += 1 }
        case .newMetrics(let frameId, let sample):
            logBus.publish(metrics: sample, frameId: frameId)
        case .rendered(let frameId):
            imageVersions[frameId, default: 0] += 1
        }
    }

    // MARK: actions

    /// Run an action, show what came of it, and handle the cloud's sudo mode.
    func perform(_ title: String, _ action: @escaping () async throws -> ActionOutcome) async {
        do {
            let outcome = try await action()
            switch outcome.kind {
            case .failed(let error):
                notice = Notice(text: "\(title): \(error)", tone: .failure)
                Haptics.failure()
            default:
                notice = Notice(text: outcome.message, tone: .success)
                Haptics.success()
            }
        } catch let error as APIError where error.needsReauth {
            reauth = ReauthRequest(error: error) { [weak self] in await self?.perform(title, action) }
        } catch {
            notice = Notice(text: "\(title): \(error.localizedDescription)", tone: .failure)
            Haptics.failure()
        }
    }

    func show(_ text: String, tone: Notice.Tone = .info) {
        notice = Notice(text: text, tone: tone)
    }
}

struct ReauthRequest: Identifiable {
    let id = UUID()
    let error: APIError
    let retry: () async -> Void

    var acceptsCode: Bool { error.body?["reauth"]?["methods"]?["code"]?.boolValue ?? true }
    var acceptsPassword: Bool { error.body?["reauth"]?["methods"]?["password"]?.boolValue ?? true }
    var acceptsPasskey: Bool { error.body?["reauth"]?["methods"]?["passkey"]?.boolValue ?? false }
    /// No password and no second factor (a Google-only account): only a new
    /// sign-in proves it, through the web.
    var acceptsSignIn: Bool { error.body?["reauth"]?["methods"]?["sign_in"]?.boolValue ?? false }
}

/// Fans the socket's log lines and metrics out to whichever screen listens.
@MainActor
final class LogBus {
    private var logListeners: [UUID: (LogLine) -> Void] = [:]
    private var metricListeners: [UUID: (String, MetricSample) -> Void] = [:]

    func publish(_ line: LogLine) { logListeners.values.forEach { $0(line) } }
    func publish(metrics: MetricSample, frameId: String) { metricListeners.values.forEach { $0(frameId, metrics) } }

    func onLog(_ handler: @escaping (LogLine) -> Void) -> UUID {
        let id = UUID()
        logListeners[id] = handler
        return id
    }

    func onMetrics(_ handler: @escaping (String, MetricSample) -> Void) -> UUID {
        let id = UUID()
        metricListeners[id] = handler
        return id
    }

    func remove(_ id: UUID) {
        logListeners[id] = nil
        metricListeners[id] = nil
    }
}
