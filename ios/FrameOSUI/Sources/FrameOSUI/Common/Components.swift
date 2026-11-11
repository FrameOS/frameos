import FrameOSKit
import SwiftUI

/// Decoded pictures by key (frame images, scene tiles, photo thumbnails).
/// Frame images are PNG on Linux frames and BMP on an ESP32: ImageIO reads both.
@MainActor
final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, PlatformImage>()

    init() { cache.countLimit = 300 }

    func get(_ key: String) -> PlatformImage? { cache.object(forKey: key as NSString) }
    func set(_ key: String, _ image: PlatformImage) { cache.setObject(image, forKey: key as NSString) }
}

/// A picture the plane serves behind the account's credentials (no
/// `AsyncImage`: it cannot send them). Shows the cached copy at once and
/// replaces it when the load finishes.
struct RemoteImage<Placeholder: View>: View {
    let key: String
    let load: () async throws -> Data
    var contentMode: ContentMode = .fit
    /// Told the picture's width over height whenever one shows.
    var onAspect: ((Double) -> Void)? = nil
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var image: PlatformImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(platformImage: image)
                    .resizable()
                    .interpolation(.medium)
                    .aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: key) {
            if let cached = ImageCache.shared.get(key) { show(cached) }
            do {
                let data = try await load()
                if let decoded = PlatformImage(data: data) {
                    ImageCache.shared.set(key, decoded)
                    show(decoded)
                }
            } catch {
                failed = true
            }
        }
    }

    private func show(_ picture: PlatformImage) {
        image = picture
        if picture.size.height > 0 { onAspect?(Double(picture.size.width / picture.size.height)) }
    }
}

/// The frame's picture, at the panel's proportions.
struct FrameImageView: View {
    @Environment(AppModel.self) private var app
    let frame: Frame
    var fresh = false
    /// The shape of the picture that came back: a frame that does not say
    /// its size (a new virtual frame) is drawn at it rather than at 4:3.
    @State private var pictureAspect: Double?

    var body: some View {
        let service = app.service
        let version = app.imageVersions[frame.id] ?? 0
        // The box is the panel's shape at the full width it is given; the
        // picture fits inside it (a picture alone sizes to itself).
        Color.black.opacity(0.04)
            .aspectRatio(frame.width != nil && frame.height != nil ? frame.aspectRatio : (pictureAspect ?? frame.aspectRatio),
                         contentMode: .fit)
            .frame(maxWidth: .infinity)
            .overlay {
                RemoteImage(key: "frame:\(app.current?.id ?? ""):\(frame.id)#\(version)\(fresh ? "!" : "")",
                            load: {
                                guard let service else { throw CancellationError() }
                                return try await service.frameImage(frame, fresh: fresh)
                            },
                            onAspect: { pictureAspect = $0 },
                            placeholder: {
                                ZStack {
                                    Rectangle().fill(.quaternary)
                                    Image(systemName: "photo").font(.title).foregroundStyle(.secondary)
                                }
                            })
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.quaternary))
    }
}

/// The healthy / busy / trouble dot next to a frame's name.
struct StatusDot: View {
    let tone: FrameStatus.Tone
    var body: some View {
        Circle().fill(color).frame(width: 9, height: 9)
            .accessibilityHidden(true)
    }

    var color: Color {
        switch tone {
        case .good: return .green
        case .busy: return .blue
        case .warn: return .orange
        case .bad: return .red
        case .idle: return .gray
        }
    }
}

/// The deploy bar (the SPA's DeployProgressBar), read from the contract.
struct DeployProgressBar: View {
    let view: DeployProgressView

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ProgressView(value: Double(view.percent), total: 100)
                .tint(view.status == .error ? .red : view.status == .done ? .green : Brand.teal)
            Text(view.caption)
                .font(.caption)
                .foregroundStyle(view.status == .error ? .red : .secondary)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(view.title)
    }
}

/// The line under a frame's name: deploy bar, firmware word, or "last seen".
struct FrameStatusLine: View {
    @Environment(AppModel.self) private var app
    let frame: Frame

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            let plane = app.current?.kind ?? .cloud
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    StatusDot(tone: FrameStatus.tone(frame))
                    Text(FrameStatus.headline(frame))
                        .font(.subheadline.weight(.medium))
                    if let battery = BatteryReading(frame) {
                        Label("\(battery.percent)%", systemImage: battery.symbol)
                            .labelStyle(.titleAndIcon)
                            .font(.caption)
                            .foregroundStyle(battery.percent <= 15 ? .red : .secondary)
                    }
                }
                if let deploy = DeployProgress.view(frame) {
                    DeployProgressBar(view: deploy)
                } else if let update = FrameStatus.firmwareUpdate(frame), let percent = update.percent {
                    ProgressView(value: Double(percent), total: 100)
                }
                if DeployProgress.view(frame)?.status != .running {
                    Text(FrameStatus.activity(frame, plane: plane))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
    }
}

/// The battery as the device reports it in its metrics (`last_metrics`).
struct BatteryReading {
    let percent: Int
    let charging: Bool

    init?(_ frame: Frame) {
        let metrics = frame.lastMetrics
        guard let value = metrics["batteryPercent"]?.doubleValue else { return nil }
        if metrics["onBattery"]?.boolValue == false && metrics["charging"]?.boolValue != true && value <= 0 { return nil }
        percent = max(0, min(100, Int(value.rounded())))
        charging = metrics["charging"]?.boolValue ?? false
    }

    var symbol: String {
        if charging { return "battery.100percent.bolt" }
        switch percent {
        case ..<13: return "battery.0percent"
        case ..<38: return "battery.25percent"
        case ..<63: return "battery.50percent"
        case ..<88: return "battery.75percent"
        default: return "battery.100percent"
        }
    }
}

/// The notice at the bottom of the screen.
struct NoticeBanner: View {
    let notice: Notice
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(color)
            Text(notice.text).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
        .padding(.horizontal, 16)
    }

    var icon: String {
        switch notice.tone {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .failure: return "exclamationmark.triangle.fill"
        }
    }

    var color: Color {
        switch notice.tone {
        case .info: return .blue
        case .success: return .green
        case .failure: return .orange
        }
    }
}

/// A button that runs an async action and shows a spinner meanwhile.
struct AsyncButton<Label: View>: View {
    var role: ButtonRole?
    let action: () async -> Void
    @ViewBuilder var label: () -> Label
    @State private var running = false

    var body: some View {
        Button(role: role) {
            guard !running else { return }
            running = true
            Task {
                await action()
                running = false
            }
        } label: {
            HStack(spacing: 8) {
                label()
                if running { ProgressView().controlSize(.small) }
            }
        }
        .disabled(running)
    }
}

/// The cloud's sudo mode: confirm it is you, then the action runs again.
struct ReauthSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    let request: ReauthRequest
    @State private var secret = ""
    @State private var error: String?

    var typesSecret: Bool { request.acceptsCode || request.acceptsPassword }

    var body: some View {
        NavigationStack {
            Form {
                if typesSecret {
                    Section {
                        if request.acceptsCode {
                            // With two-factor sign-in on, the cloud takes the code
                            // (or a recovery code), never the password.
                            TextField("Code from your authenticator", text: $secret).codeInput()
                        } else {
                            SecureField("Password", text: $secret).passwordInput()
                        }
                    } header: {
                        Text("Confirm it is you")
                    } footer: {
                        if let error { Text(error).foregroundStyle(.red) }
                        else if request.acceptsCode { Text("A recovery code works too.") }
                    }
                }
                if request.acceptsSignIn || request.acceptsPasskey || !typesSecret {
                    Section {
                        AsyncButton {
                            await confirmOnWeb()
                        } label: {
                            Label(request.acceptsSignIn ? "Continue with Google" : "Use a passkey or another way",
                                  systemImage: request.acceptsSignIn ? "person.crop.circle.badge.checkmark" : "person.badge.key")
                        }
                    } header: {
                        if !typesSecret { Text("Confirm it is you") }
                    } footer: {
                        if let error, !typesSecret { Text(error).foregroundStyle(.red) }
                        else { Text("Opens the FrameOS Cloud sign-in page to check it is you.") }
                    }
                }
            }
            .navigationTitle("Confirm")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton {
                        await confirm()
                    } label: { Text("Confirm") }
                    .disabled(secret.isEmpty || !typesSecret)
                }
            }
        }
    }

    /// Through the web (Google, a passkey): a new session with a fresh proof
    /// replaces the app's (cloud/docs/auth.md "Signing in to the app").
    func confirmOnWeb() async {
        guard let account = app.current, account.kind == .cloud else { return }
        let signIn = CloudWebSignIn(baseURL: account.baseURL, provider: request.acceptsSignIn ? .google : nil, reauth: true)
        do {
            let callback = try await WebSignIn.open(webAuthenticationSession, signIn.url)
            let (_, client) = try await AuthService.cloudFinishWebSignIn(signIn, callback: callback, expecting: account)
            await app.adoptSession(client, for: account)
            dismiss()
            await request.retry()
        } catch where WebSignIn.wasCancelled(error) {
        } catch {
            self.error = error.localizedDescription
        }
    }

    func confirm() async {
        guard let client = app.service?.client else { return }
        let code = request.acceptsCode ? secret.trimmingCharacters(in: .whitespaces) : nil
        do {
            try await AuthService.cloudReauth(client, password: code == nil ? secret : nil, code: code)
            dismiss()
            await request.retry()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// "Last seen 3 minutes ago"-style relative words for any timestamp.
func relativeWords(_ timestamp: String?) -> String? {
    FrameTime.relative(timestamp)
}

func byteWords(_ bytes: Int) -> String {
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    formatter.allowsNonnumericFormatting = false // "0 KB", not "Zero KB"
    return formatter.string(fromByteCount: Int64(bytes))
}
