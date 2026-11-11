import FrameOSKit
import SwiftUI

struct FrameDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let frameId: String
    @State private var model: FrameDetailModel
    @State private var openScene: InstalledScene?
    @State private var addingScene = false
    @State private var addingLayout = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmReboot = false
    @State private var confirmDelete = false
    @State private var confirmDiscard = false
    @State private var freshImage = false

    init(frameId: String) {
        self.frameId = frameId
        _model = State(initialValue: FrameDetailModel(frameId: frameId))
    }

    var body: some View {
        Group {
            if let frame = app.frame(frameId) {
                content(frame)
            } else {
                ContentUnavailableView("This frame is gone", systemImage: "photo.on.rectangle")
            }
        }
        .task { await model.load(app) }
        .refreshable { await model.load(app) }
    }

    @ViewBuilder func content(_ frame: Frame) -> some View {
        let kind = app.current?.kind ?? .cloud
        List {
            Section {
                FrameImageView(frame: frame, fresh: freshImage)
                    .id(model.imageNonce)
                    .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 8, trailing: 12))
                    .onTapGesture {
                        freshImage = true
                        model.refreshImage(app)
                    }
                    .accessibilityHint("Tap to fetch the picture the frame shows now")
                FrameStatusLine(frame: frame)
                actionsRow(frame)
            }

            if kind == .cloud && frame.status == "pending" {
                Section {
                    Text("This frame joined with a claim code and waits for you to confirm it is yours.")
                    AsyncButton { await model.confirm(app) } label: { Text("Confirm frame").fontWeight(.semibold) }
                } header: {
                    Text("Waiting for you")
                }
            }

            if let brought = model.deviceScenes {
                Section {
                    Text("The frame has \(brought.count) scene\(brought.count == 1 ? "" : "s") of its own\(brought.names.isEmpty ? "" : ": " + brought.names.prefix(5).joined(separator: ", ")). Import them to keep them on its list.")
                        .font(.callout)
                    HStack {
                        AsyncButton { await model.resolveDeviceScenes(app, importThem: true) } label: { Text("Import") }
                            .buttonStyle(.borderedProminent)
                        AsyncButton { await model.resolveDeviceScenes(app, importThem: false) } label: { Text("Leave them") }
                            .buttonStyle(.bordered)
                    }
                } header: {
                    Text("Scenes on the frame")
                }
            }

            if let preview = ScenePreview(frame.scenePreview) {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(preview.name).font(.headline)
                        Text("Shown for now (\(preview.source == "voice" ? "voice chat" : "preview")). It is on no list: install it to keep it.")
                            .font(.footnote).foregroundStyle(.secondary)
                        HStack {
                            AsyncButton { await model.installPreview(app) } label: { Text("Install") }
                                .buttonStyle(.borderedProminent)
                            Button("Discard", role: .destructive) { confirmDiscard = true }
                                .buttonStyle(.bordered)
                        }
                        .padding(.top, 4)
                    }
                } header: {
                    Text("Preview")
                }
            }

            Section {
                if model.scenesLoading && model.scenes.isEmpty {
                    ProgressView()
                } else if let error = model.scenesError {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                } else if model.listedScenes.isEmpty {
                    Text("No scenes on this frame yet.").foregroundStyle(.secondary)
                }
                ForEach(model.listedScenes) { scene in
                    Button {
                        openScene = scene
                    } label: {
                        SceneRow(frame: frame, scene: scene, active: model.isActive(scene))
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing) {
                        if !model.isActive(scene) {
                            Button("Activate") { Task { await model.activate(app, scene) } }.tint(Brand.teal)
                        }
                    }
                }
                Button {
                    addingScene = true
                } label: {
                    Label("Add scene", systemImage: "plus.circle.fill")
                }
                NavigationLink {
                    ChatView(frameId: frameId, chatId: nil, generating: true)
                } label: { GenerateSceneLabel() }
            } header: {
                Text("Scenes")
            }

            if !model.layouts.isEmpty {
                FrameLayoutsSection(frameId: frameId, model: model, addingLayout: $addingLayout)
            }

            if !model.commands.isEmpty {
                Section {
                    ForEach(model.commands) { command in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(command.label)
                                Text(command.status == "sent" ? "sent, not confirmed" : "waiting")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let created = relativeWords(command.createdAt) {
                                Text(created).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions {
                            Button("Cancel", role: .destructive) { Task { await model.cancel(app, command) } }
                        }
                    }
                } header: {
                    Text("Waiting for the frame")
                } footer: {
                    if let wake = FrameStatus.checkin(frame), wake.kind == .sleeping {
                        Text("The frame is asleep; it takes these when it wakes.")
                    }
                }
            }

            Section {
                NavigationLink {
                    FrameSettingsView(frameId: frameId)
                } label: { Label("Settings", systemImage: "slider.horizontal.3") }
                NavigationLink {
                    ScheduleView(frameId: frameId, scenes: model.listedScenes)
                } label: { Label("Schedule", systemImage: "calendar") }
                NavigationLink {
                    ButtonMapView(frameId: frameId, scenes: model.listedScenes)
                } label: { Label("Button actions", systemImage: "button.programmable") }
                if Microphone.present(frame, plane: kind) {
                    NavigationLink {
                        VoicePermissionsView(frameId: frameId)
                    } label: { Label("Voice chat", systemImage: "mic") }
                }
                NavigationLink {
                    AssetsView(frameId: frameId, folder: "")
                } label: { Label("Assets", systemImage: "folder") }
                NavigationLink {
                    LogsView(frameId: frameId)
                } label: { Label("Logs", systemImage: "text.alignleft") }
                NavigationLink {
                    MetricsView(frameId: frameId)
                } label: { Label("Metrics", systemImage: "chart.xyaxis.line") }
                NavigationLink {
                    ChatView(frameId: frameId, chatId: nil)
                } label: { Label("Ask AI about this frame", systemImage: "sparkles") }
            }

            Section {
                LabeledContent("Device", value: deviceWords(frame))
                if let width = frame.width, let height = frame.height {
                    LabeledContent("Size", value: "\(width) × \(height)\((frame.rotate ?? 0) != 0 ? " · rotated \(frame.rotate!)°" : "")")
                }
                if let version = frame.frameosVersion ?? frame["version"]?.stringValue {
                    LabeledContent("FrameOS", value: version)
                }
                if let release = model.latestRelease, model.updateAvailable(frame) {
                    LabeledContent("Newest release", value: release)
                }
                LabeledContent("Control plane", value: app.current?.planeLabel ?? "")
            } header: {
                Text("About")
            }
        }
        .groupedList()
        .navigationTitle(frame.displayName)
        .inlineTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) { moreMenu(frame) }
        }
        .sheet(item: $openScene) { scene in
            SceneSheet(frameId: frameId, scene: scene, model: model)
        }
        // Reloaded on close: a scene can also come in through Generate scene's
        // chat inside the sheet, which is no catalog install.
        .sheet(isPresented: $addingScene, onDismiss: { Task { await model.load(app) } }) {
            // A frame with no layout yet has "Add layout" there (the SPA's
            // drawer); one with a layout has New layout under Layouts.
            CatalogView(installTarget: frame,
                        addLayout: model.layouts.isEmpty ? { starter in await model.addLayout(app, starter) } : nil)
        }
        .sheet(isPresented: $addingLayout) {
            NavigationStack {
                LayoutStartersView { starter in await model.addLayout(app, starter) }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Close") { addingLayout = false } }
                    }
            }
        }
        .alert("Rename frame", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let name = newName.trimmingCharacters(in: .whitespaces)
                Task {
                    await model.run(app, "Rename") { service, frame in
                        try await service.rename(frame, to: name)
                        return ActionOutcome(kind: .done, message: "Renamed.")
                    }
                }
            }
        }
        .confirmationDialog("Reboot \(frame.displayName)?", isPresented: $confirmReboot, titleVisibility: .visible) {
            Button("Reboot", role: .destructive) {
                Task { await model.run(app, "Reboot") { try await $0.reboot($1) } }
            }
        } message: {
            Text("The whole device restarts. It is back in a minute or two.")
        }
        .confirmationDialog("Discard the preview?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { Task { await model.discardPreview(app) } }
        } message: {
            Text("A discarded preview is gone for good: no list holds it.")
        }
        .confirmationDialog("Delete \(frame.displayName)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete frame", role: .destructive) {
                Task {
                    await app.perform("Delete") {
                        try await app.service?.delete(frame)
                        await MainActor.run {
                            app.frames.removeAll { $0.id == frame.id }
                            dismiss()
                        }
                        return ActionOutcome(kind: .done, message: "Deleted \(frame.displayName).")
                    }
                }
            }
        } message: {
            Text(kind == .cloud
                ? "The frame is removed from your account and stops talking to FrameOS Cloud."
                : "The frame, its logs and images are removed from this backend. The device keeps running what it has.")
        }
    }

    @ViewBuilder func actionsRow(_ frame: Frame) -> some View {
        HStack(spacing: 10) {
            ActionTile(title: "Render", symbol: "arrow.clockwise") {
                await model.run(app, "Render") { try await $0.render($1) }
                freshImage = true
                model.refreshImage(app)
            }
            ActionTile(title: "Restart", symbol: "restart") {
                await model.run(app, "Restart") { try await $0.restart($1) }
            }
            if app.current?.kind == .backend {
                ActionTile(title: "Deploy", symbol: "arrow.up.circle") {
                    await model.run(app, "Deploy") { try await $0.deploy($1) }
                }
            }
            ActionTile(title: "Reboot", symbol: "power") { confirmReboot = true }
        }
        .buttonStyle(.borderless)
        .padding(.vertical, 2)
    }

    @ViewBuilder func moreMenu(_ frame: Frame) -> some View {
        Menu {
            Button {
                newName = frame.name
                renaming = true
            } label: { Label("Rename", systemImage: "pencil") }
            Button {
                Task { await model.run(app, "Update") { try await $0.updateFirmware($1) } }
            } label: {
                Label(frame.isEmbedded ? "Update firmware" : "Update FrameOS",
                      systemImage: model.updateAvailable(frame) ? "arrow.down.circle.fill" : "arrow.down.circle")
            }
            if !frame.isEmbedded {
                Button {
                    Task { await model.run(app, "Screen on") { try await $0.setDisplay($1, on: true) } }
                } label: { Label("Turn screen on", systemImage: "sun.max") }
                Button {
                    Task { await model.run(app, "Screen off") { try await $0.setDisplay($1, on: false) } }
                } label: { Label("Turn screen off", systemImage: "moon") }
            }
            if app.current?.kind == .backend {
                Button {
                    Task { await model.run(app, "Deploy") { try await $0.deploy($1, full: true) } }
                } label: { Label("Deploy FrameOS, scenes & settings", systemImage: "shippingbox") }
            }
            Divider()
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete frame", systemImage: "trash") }
        } label: {
            Image(systemName: "ellipsis.circle").accessibilityLabel("More")
        }
    }

    func deviceWords(_ frame: Frame) -> String {
        if let board = frame.hardware["board"]?.stringValue, !board.isEmpty { return board }
        if let device = frame.device ?? frame.hardware["device"]?.stringValue, !device.isEmpty { return device }
        return frame.isEmbedded ? "ESP32" : (frame.mode ?? "Raspberry Pi")
    }
}

struct ActionTile: View {
    let title: String
    let symbol: String
    let action: () async -> Void
    @State private var running = false

    var body: some View {
        Button {
            guard !running else { return }
            running = true
            Task {
                await action()
                running = false
            }
        } label: {
            VStack(spacing: 6) {
                ZStack {
                    Image(systemName: symbol).font(.title3).opacity(running ? 0 : 1)
                    if running { ProgressView().controlSize(.small) }
                }
                .frame(height: 24)
                Text(title).font(.caption)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .disabled(running)
    }
}

/// A scene on the frame's list: its last picture, its name, what is up with it.
struct SceneRow: View {
    @Environment(AppModel.self) private var app
    let frame: Frame
    let scene: InstalledScene
    let active: Bool

    var body: some View {
        HStack(spacing: 12) {
            let service = app.service
            RemoteImage(key: "scene:\(frame.id):\(scene.id):\(app.imageVersions[frame.id] ?? 0)",
                        load: {
                            guard let service else { throw CancellationError() }
                            return try await service.sceneImage(frame, sceneId: scene.id)
                        },
                        contentMode: .fill,
                        placeholder: { Rectangle().fill(.quaternary) })
                .frame(width: 56, height: 42)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(scene.name).font(.body).lineLimit(1)
                HStack(spacing: 6) {
                    if active { Tag(text: "showing", color: .green) }
                    if scene.updateAvailable { Tag(text: "update", color: .blue) }
                    if !scene.missingSettingsGroups.isEmpty { Tag(text: "needs keys", color: .orange) }
                    if scene.isDefault { Tag(text: "on boot", color: .gray) }
                }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

struct Tag: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
}
