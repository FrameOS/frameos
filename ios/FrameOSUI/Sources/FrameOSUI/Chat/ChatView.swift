import FrameOSKit
import Observation
import SwiftUI

/// One conversation with the AI (docs/ai-chat.md): the same agent loop the
/// web's chat boxes run, on either plane.
@Observable @MainActor
final class ChatModel {
    var chatId: String?
    let frameId: String?
    var messages: [ChatMessage] = []
    var draft = ""
    var running = false
    var tools: [(label: String, status: String)] = []
    var error: String?
    private var task: Task<Void, Never>?

    init(chatId: String?, frameId: String?) {
        self.chatId = chatId
        self.frameId = frameId
    }

    func load(_ app: AppModel) async {
        guard let chatId, let service = app.service, messages.isEmpty else { return }
        messages = (try? await service.chatMessages(chatId)) ?? []
    }

    func send(_ app: AppModel) {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !running, let service = app.service else { return }
        draft = ""
        error = nil
        running = true
        tools = []
        messages.append(ChatMessage(role: "user", content: prompt))
        var reply = ChatMessage(role: "assistant", content: "")
        messages.append(reply)
        let frame = frameId.flatMap { app.frame($0) }
        task = Task {
            do {
                for try await event in service.chat(prompt: prompt, chatId: chatId, frame: frame) {
                    switch event {
                    case .started(let id, _):
                        chatId = id
                    case .delta(let text):
                        reply.content += text
                    case .tool(_, let label, let status, _):
                        if let index = tools.firstIndex(where: { $0.label == label }) {
                            tools[index].status = status
                        } else {
                            tools.append((label, status))
                        }
                    case .proposal(let proposal):
                        reply.proposals.append(proposal)
                    case .done(let text):
                        if reply.content.isEmpty, let text { reply.content = text }
                    case .failed(let detail):
                        error = detail
                    }
                    if let index = messages.firstIndex(where: { $0.id == reply.id }) { messages[index] = reply }
                }
            } catch {
                self.error = error.localizedDescription
            }
            if reply.content.isEmpty && reply.proposals.isEmpty {
                messages.removeAll { $0.id == reply.id }
            }
            running = false
            if let frameId { await app.reloadFrame(frameId) }
        }
    }

    func stop() {
        task?.cancel()
        running = false
    }
}

struct ChatView: View {
    @Environment(AppModel.self) private var app
    @State private var model: ChatModel
    /// Asked once before the first message (App Store guideline 5.1.2(i)):
    /// the chat's words go to OpenAI.
    @AppStorage("ai.sharing.allowed") private var sharingAllowed = false
    @FocusState private var typing: Bool
    let frameId: String?
    /// Opened from "Generate scene" (the web's Add scene drawer has the same
    /// entry): the empty chat asks for a scene and the field takes focus.
    let generating: Bool

    init(frameId: String?, chatId: String?, generating: Bool = false) {
        self.frameId = frameId
        self.generating = generating
        _model = State(initialValue: ChatModel(chatId: chatId, frameId: frameId))
    }

    var intro: String {
        if generating { return "Describe the scene you want, and the AI makes it for this frame." }
        return frameId == nil ? "Ask about your frames, or have a scene made."
            : "Ask about this frame, change what it shows, or have a scene made for it."
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if model.messages.isEmpty {
                            VStack(spacing: 8) {
                                Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(Brand.teal)
                                Text(intro)
                                    .multilineTextAlignment(.center)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                        }
                        ForEach(model.messages) { message in
                            MessageBubble(message: message).id(message.id)
                        }
                        if model.running {
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(Array(model.tools.enumerated()), id: \.offset) { _, tool in
                                    Label(tool.label, systemImage: tool.status == "done" ? "checkmark.circle" : tool.status == "error" ? "xmark.circle" : "circle.dotted")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                ProgressView().controlSize(.small)
                            }
                            .id("running")
                        }
                        if let error = model.error {
                            Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout)
                        }
                    }
                    .padding()
                    // One column of messages on an iPad, not lines across the screen.
                    .frame(maxWidth: ReadableWidth.chat)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: model.messages.last?.content) { _, _ in
                    if let last = model.messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            Divider()
            if !sharingAllowed {
                AISharingConsent(plane: app.current?.kind ?? .cloud) { sharingAllowed = true }
                    .frame(maxWidth: ReadableWidth.chat)
            } else {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(generating ? "Describe a scene" : "Message", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                    .focused($typing)
                    .onSubmit { model.send(app) }
                if model.running {
                    Button { model.stop() } label: { Image(systemName: "stop.circle.fill").font(.title2) }
                        .accessibilityLabel("Stop")
                } else {
                    Button { model.send(app) } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        .disabled(model.draft.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityLabel("Send")
                }
            }
            .padding(10)
            .frame(maxWidth: ReadableWidth.chat)
            }
        }
        .navigationTitle(generating ? "Generate scene" : frameId.flatMap { app.frame($0)?.displayName } ?? "AI")
        .inlineTitle()
        .task { await model.load(app) }
        .onAppear { if generating && sharingAllowed { typing = true } }
        .onChange(of: sharingAllowed) { _, allowed in if generating && allowed { typing = true } }
    }
}

/// "Generate scene" as a row: the frame page beside Add scene, and the top of
/// the Add scene sheet (the web's drawer).
struct GenerateSceneLabel: View {
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Generate scene")
                Text("Open AI chat for this frame").font(.caption).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "sparkles").foregroundStyle(.tint)
        }
    }
}

struct MessageBubble: View {
    @Environment(AppModel.self) private var app
    let message: ChatMessage

    var body: some View {
        let mine = message.role == "user"
        VStack(alignment: mine ? .trailing : .leading, spacing: 8) {
            if !message.content.isEmpty {
                Text(LocalizedStringKey(message.content))
                    .textSelection(.enabled)
                    .padding(10)
                    .background(mine ? Brand.teal.opacity(0.15) : Color.secondary.opacity(0.1),
                                in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            ForEach(Array(message.proposals.enumerated()), id: \.offset) { _, proposal in
                ProposalCard(proposal: proposal)
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
}

/// The cloud chat's "install this scene" card: the AI never installs on its own.
struct ProposalCard: View {
    @Environment(AppModel.self) private var app
    let proposal: JSONValue
    @State private var done = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(proposal["scene"]?["name"]?.stringValue ?? "A scene").font(.headline)
            Text("Install on \(proposal["frame"]?["name"]?.stringValue ?? "the frame")").font(.subheadline).foregroundStyle(.secondary)
            if let groups = proposal["declared_settings_groups"]?.arrayValue, !groups.isEmpty {
                Text("It uses your API keys for: \(groups.compactMap(\.stringValue).joined(separator: ", ")).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            AsyncButton {
                guard let service = app.service else { return }
                await app.perform("Install") {
                    let outcome = try await service.approveProposal(proposal)
                    await MainActor.run { done = true }
                    return outcome
                }
            } label: { Text(done ? "Installed" : "Approve and install") }
            .buttonStyle(.borderedProminent)
            .disabled(done)
        }
        .padding(12)
        .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.quaternary))
    }
}

/// The AI tab: earlier conversations and a new one.
struct ChatListView: View {
    @Environment(AppModel.self) private var app
    @State private var chats: [ChatSummary] = []
    @State private var loading = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        ChatView(frameId: nil, chatId: nil)
                    } label: { Label("New chat", systemImage: "square.and.pencil") }
                }
                Section("Earlier") {
                    ForEach(chats) { chat in
                        NavigationLink {
                            ChatView(frameId: nil, chatId: chat.id)
                        } label: {
                            VStack(alignment: .leading) {
                                Text(chat.title).lineLimit(1)
                                if let updated = relativeWords(chat.updatedAt) {
                                    Text(updated).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .swipeActions {
                            Button("Delete", role: .destructive) {
                                Task {
                                    try? await app.service?.deleteChat(chat.id)
                                    await load()
                                }
                            }
                        }
                    }
                    if chats.isEmpty && !loading { Text("No conversations yet.").foregroundStyle(.secondary) }
                }
            }
            .readableWidth()
            .navigationTitle("AI")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    func load() async {
        loading = true
        defer { loading = false }
        chats = (try? await app.service?.chats(frame: nil)) ?? []
    }
}

/// What the AI chat shares, asked before its first message.
struct AISharingConsent: View {
    @Environment(\.openURL) private var openURL
    let plane: PlaneKind
    let allow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Before you chat", systemImage: "sparkles").font(.headline)
            Text(plane == .cloud
                ? "To answer, FrameOS Cloud sends your messages and the details of the frames and scenes you ask about to OpenAI. OpenAI processes them to write the answer."
                : "To answer, your backend sends your messages and the details of the frames and scenes you ask about to OpenAI, with the OpenAI key set on the backend.")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
                Button("Allow and chat", action: allow).buttonStyle(.borderedProminent)
                Button("Privacy policy") { openURL(Legal.privacy) }.buttonStyle(.bordered)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
