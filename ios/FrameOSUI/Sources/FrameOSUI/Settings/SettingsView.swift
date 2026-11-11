import FrameOSKit
import SwiftUI

/// Accounts (FrameOS Cloud and self-hosted backends), the account's API
/// keys, and about.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var adding = false
    @State private var addingBackend = false
    @State private var summary: JSONValue?
    @State private var confirmSignOut: Account?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(app.accounts) { account in
                        Button {
                            app.activate(account)
                        } label: {
                            HStack {
                                Image(systemName: account.kind == .cloud ? "cloud" : "server.rack")
                                    .frame(width: 24)
                                VStack(alignment: .leading) {
                                    Text(account.planeLabel)
                                    Text(account.email).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if account.id == app.current?.id { Image(systemName: "checkmark").foregroundStyle(Brand.teal) }
                            }
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Sign out", role: .destructive) { confirmSignOut = account }
                        }
                    }
                    Button { adding = true } label: { Label("Add a FrameOS Cloud account", systemImage: "plus") }
                    Button { addingBackend = true } label: { Label("Add a self-hosted backend", systemImage: "server.rack") }
                } header: {
                    Text("Accounts")
                } footer: {
                    Text("Swipe an account to sign out of it.")
                }

                if let current = app.current {
                    Section("This account") {
                        LabeledContent("Signed in as", value: current.email)
                        if current.kind == .cloud, let plan = summary?["usage"]?["plan"]?["name"]?.stringValue {
                            LabeledContent("Plan", value: plan)
                        }
                        if let frames = summary?["usage"]?["frames"] {
                            LabeledContent("Frames", value: "\(frames["count"]?.intValue ?? 0) of \(frames["max_count"]?.intValue ?? 0)")
                        }
                        if let photos = summary?["usage"]?["photos"], let max = photos["max_bytes"]?.intValue, max > 0 {
                            LabeledContent("Photos", value: "\(byteWords(photos["bytes"]?.intValue ?? 0)) of \(byteWords(max))")
                        }
                        NavigationLink {
                            ServiceKeysView()
                        } label: { Label("API keys for scenes", systemImage: "key") }
                        Button {
                            openURL(current.baseURL.appendingPathComponent(current.kind == .cloud ? "frames" : ""))
                        } label: { Label("Open the web workspace", systemImage: "safari") }
                        if current.kind == .cloud {
                            Button {
                                openURL(current.baseURL.appendingPathComponent("account/usage"))
                            } label: { Label("Plan and billing", systemImage: "creditcard") }
                        }
                    }
                }

                Section("About") {
                    LabeledContent("App version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")
                    Button { openURL(URL(string: "https://frameos.net")!) } label: { Label("frameos.net", systemImage: "globe") }
                    Button { openURL(URL(string: "https://github.com/FrameOS/frameos")!) } label: {
                        Label("Source code", systemImage: "chevron.left.forwardslash.chevron.right")
                    }
                }
            }
            .groupedList()
            .navigationTitle("Settings")
            .task(id: app.current?.id) {
                summary = try? await app.service?.accountSummary()
            }
            .sheet(isPresented: $adding) { SignInView(isSheet: true) }
            .sheet(isPresented: $addingBackend) { SignInView(isSheet: true, startWithBackend: true) }
            .confirmationDialog("Sign out of \(confirmSignOut?.planeLabel ?? "")?",
                                isPresented: Binding { confirmSignOut != nil } set: { if !$0 { confirmSignOut = nil } },
                                titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    guard let account = confirmSignOut else { return }
                    Task { await app.signOut(account) }
                }
            }
        }
    }
}

/// The account's API keys that scenes may be granted (Unsplash, OpenAI,
/// Home Assistant, ...). Values come masked; a masked value saved back keeps
/// the stored key.
struct ServiceKeysView: View {
    @Environment(AppModel.self) private var app
    @State private var settings: [String: JSONValue] = [:]
    @State private var edits: [String: [String: String]] = [:]
    @State private var loading = false

    /// The SPA's ServicesSettingsForm groups; a backend's AI chat has a key of its own.
    var groups: [(key: String, title: String, fields: [(String, String)])] {
        [
        ("openAI", "OpenAI", app.current?.kind == .backend
            ? [("apiKey", "API key for frames"), ("backendApiKey", "API key for AI chat")]
            : [("apiKey", "API key for frames")]),
        ("unsplash", "Unsplash", [("accessKey", "Access key")]),
        ("homeAssistant", "Home Assistant", [("url", "URL"), ("accessToken", "Access token")]),
        ("immich", "Immich", [("url", "URL"), ("apiKey", "API key")]),
        ("github", "GitHub", [("api_key", "API key")]),
        ]
    }

    var body: some View {
        Form {
            ForEach(groups, id: \.key) { group in
                Section(group.title) {
                    ForEach(group.fields, id: \.0) { field, title in
                        TextField(title, text: binding(group.key, field)).plainInput()
                    }
                    if edits[group.key] != nil {
                        AsyncButton {
                            await save(group.key)
                        } label: { Text("Save \(group.title)") }
                    }
                }
            }
        }
        .overlay { if loading && settings.isEmpty { ProgressView() } }
        .navigationTitle("API keys")
        .inlineTitle()
        .task { await load() }
    }

    func binding(_ group: String, _ field: String) -> Binding<String> {
        Binding {
            edits[group]?[field] ?? settings[group]?[field]?.stringValue ?? ""
        } set: {
            edits[group, default: [:]][field] = $0
        }
    }

    func load() async {
        loading = true
        defer { loading = false }
        settings = (try? await app.service?.serviceSettings()) ?? [:]
    }

    func save(_ group: String) async {
        guard let service = app.service else { return }
        var values = settings[group]?.objectValue ?? [:]
        for (field, value) in edits[group] ?? [:] { values[field] = .string(value) }
        let payload = values
        await app.perform("Save keys") {
            try await service.saveServiceSettings(group: group, values: payload)
            return ActionOutcome(kind: .done, message: "Saved.")
        }
        edits[group] = nil
        await load()
    }
}
