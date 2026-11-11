import FrameOSKit
import Observation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

@Observable @MainActor
final class AssetsModel {
    let frameId: String
    let folder: String
    var entries: [AssetEntry] = []
    var loading = false
    var error: String?
    var mounted: Bool?
    var uploadProgress: Double?

    init(frameId: String, folder: String) {
        self.frameId = frameId
        self.folder = folder
    }

    func load(_ app: AppModel, refresh: Bool = false) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        loading = true
        defer { loading = false }
        var attempts = 0
        var refreshNow = refresh
        while attempts < 4 {
            attempts += 1
            do {
                let listing = try await service.assets(frame, folder: folder, refresh: refreshNow)
                entries = listing.entries
                mounted = listing.mounted
                error = nil
                // The cloud asks the frame for its listing: look again shortly.
                guard listing.refreshing, let wait = listing.retryAfter else { return }
                refreshNow = false
                try? await Task.sleep(nanoseconds: UInt64(max(1, min(wait, 5)) * 1_000_000_000))
            } catch {
                self.error = error.localizedDescription
                return
            }
        }
    }

    func path(_ name: String) -> String { folder.isEmpty ? name : "\(folder)/\(name)" }

    func upload(_ app: AppModel, filename: String, data: Data) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        uploadProgress = 0
        defer { uploadProgress = nil }
        let folder = self.folder
        await app.perform("Upload") {
            try await service.uploadAsset(frame, folder: folder, filename: filename, data: data) { value in
                Task { @MainActor in self.uploadProgress = value }
            }
            return ActionOutcome(kind: .done, message: "Uploaded \(filename).")
        }
        await load(app)
    }

    func makeFolder(_ app: AppModel, name: String) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        let target = path(name)
        await app.perform("New folder") {
            try await service.createAssetFolder(frame, path: target)
            return ActionOutcome(kind: .done, message: "Created \(name).")
        }
        await load(app)
    }

    func rename(_ app: AppModel, _ entry: AssetEntry, to name: String) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        let target = path(name)
        await app.perform("Rename") {
            try await service.renameAsset(frame, from: entry.path, to: target)
            return ActionOutcome(kind: .done, message: "Renamed.")
        }
        await load(app)
    }

    func delete(_ app: AppModel, _ entry: AssetEntry) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        await app.perform("Delete") {
            try await service.deleteAsset(frame, path: entry.path)
            return ActionOutcome(kind: .done, message: "Deleted \(entry.name).")
        }
        await load(app)
    }
}

/// The files on the frame (the Assets panel): browse, look, upload, rename, delete.
struct AssetsView: View {
    @Environment(AppModel.self) private var app
    let frameId: String
    let folder: String
    @State private var model: AssetsModel
    @State private var importing = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var newFolder = false
    @State private var folderName = ""
    @State private var renaming: AssetEntry?
    @State private var renameText = ""
    @State private var viewing: AssetEntry?

    init(frameId: String, folder: String) {
        self.frameId = frameId
        self.folder = folder
        _model = State(initialValue: AssetsModel(frameId: frameId, folder: folder))
    }

    var body: some View {
        List {
            if model.mounted == false {
                Label("No SD card in the frame: it has nowhere to keep files.", systemImage: "sdcard")
                    .foregroundStyle(.orange)
            }
            if let progress = model.uploadProgress {
                ProgressView("Uploading", value: progress)
            }
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            }
            ForEach(model.entries) { entry in
                Group {
                    if entry.isDir {
                        NavigationLink {
                            AssetsView(frameId: frameId, folder: entry.path)
                        } label: {
                            Label(entry.name, systemImage: "folder.fill")
                        }
                    } else {
                        Button {
                            viewing = entry
                        } label: {
                            HStack {
                                Label(entry.name, systemImage: entry.isImage ? "photo" : "doc")
                                Spacer()
                                Text(byteWords(entry.size)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .swipeActions {
                    Button("Delete", role: .destructive) { Task { await model.delete(app, entry) } }
                    Button("Rename") {
                        renameText = entry.name
                        renaming = entry
                    }
                }
            }
            if model.entries.isEmpty && !model.loading && model.error == nil {
                Text("Empty folder.").foregroundStyle(.secondary)
            }
        }
        .overlay { if model.loading && model.entries.isEmpty { ProgressView() } }
        .navigationTitle(folder.isEmpty ? "Assets" : (folder.split(separator: "/").last.map(String.init) ?? folder))
        .inlineTitle()
        .task { await model.load(app) }
        .refreshable { await model.load(app, refresh: true) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { importing = true } label: { Label("Upload a file", systemImage: "doc.badge.plus") }
                    // A plain button: a PhotosPicker inside a Menu did not open on iOS 27 (the UI tour found it).
                    Button { pickingPhotos = true } label: { Label("Upload photos", systemImage: "photo.badge.plus") }
                    Button { newFolder = true } label: { Label("New folder", systemImage: "folder.badge.plus") }
                } label: {
                    Image(systemName: "plus").accessibilityLabel("Add")
                }
            }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: nil,
                      matching: .images, preferredItemEncoding: .compatible)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task {
                for url in urls {
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    if let data = try? Data(contentsOf: url) {
                        await model.upload(app, filename: url.lastPathComponent, data: data)
                    }
                }
            }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    if let photo = await PickedPhoto.load(item) {
                        await model.upload(app, filename: photo.filename, data: photo.data)
                    }
                }
                photoItems = []
            }
        }
        .alert("New folder", isPresented: $newFolder) {
            TextField("Name", text: $folderName)
            Button("Cancel", role: .cancel) { folderName = "" }
            Button("Create") {
                let name = folderName.trimmingCharacters(in: .whitespaces)
                folderName = ""
                guard !name.isEmpty else { return }
                Task { await model.makeFolder(app, name: name) }
            }
        }
        .alert("Rename", isPresented: Binding { renaming != nil } set: { if !$0 { renaming = nil } }) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") {
                guard let entry = renaming else { return }
                let name = renameText.trimmingCharacters(in: .whitespaces)
                renaming = nil
                Task { await model.rename(app, entry, to: name) }
            }
        }
        .sheet(item: $viewing) { entry in
            AssetPreview(frameId: frameId, entry: entry)
        }
    }
}

struct AssetPreview: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let frameId: String
    let entry: AssetEntry
    @State private var data: Data?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let data, let image = PlatformImage(data: data) {
                    ScrollView { Image(platformImage: image).resizable().scaledToFit().padding() }
                } else if let data, let text = String(data: data.prefix(200_000), encoding: .utf8) {
                    ScrollView { Text(text).font(.caption.monospaced()).textSelection(.enabled).padding() }
                } else if let data {
                    ContentUnavailableView(entry.name, systemImage: "doc", description: Text(byteWords(data.count)))
                } else if let error {
                    ContentUnavailableView("Could not open it", systemImage: "exclamationmark.triangle", description: Text(error))
                } else {
                    ProgressView("Asking the frame")
                }
            }
            .navigationTitle(entry.name)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                if let data {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: SharedFile(data: data, name: entry.name), preview: SharePreview(entry.name))
                    }
                }
            }
            .task {
                guard let service = app.service, let frame = app.frame(frameId) else { return }
                do { data = try await service.assetData(frame, path: entry.path) } catch { self.error = error.localizedDescription }
            }
        }
    }
}

/// A file to hand to the share sheet.
struct SharedFile: Transferable {
    let data: Data
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .data) { file in
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(file.name)
            try file.data.write(to: url)
            return SentTransferredFile(url)
        }
    }
}
