import FrameOSKit
import Observation
import PhotosUI
import SwiftUI

@Observable @MainActor
final class PhotoFolderModel {
    let path: String
    var entries: [PhotoEntry] = []
    var loading = false
    var error: String?
    var status: PhotosStatus?
    var uploading: (done: Int, total: Int, progress: Double)?

    init(path: String) { self.path = path }

    func load(_ app: AppModel) async {
        guard let service = app.service else { return }
        loading = true
        defer { loading = false }
        do {
            if path.isEmpty { status = try? await service.photosStatus() }
            entries = try await service.photos(in: path)
            error = nil
        } catch let failure as APIError where failure.code == "photos_unavailable" || failure.status == 503 {
            error = status?.message ?? failure.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    func upload(_ app: AppModel, _ items: [PhotosPickerItem]) async {
        guard let service = app.service else { return }
        uploading = (0, items.count, 0)
        defer { uploading = nil }
        var failures: [String] = []
        for (index, item) in items.enumerated() {
            guard let photo = await PickedPhoto.load(item) else {
                failures.append("one photo could not be read")
                continue
            }
            do {
                try await service.uploadPhoto(folder: path, filename: photo.filename, data: photo.data) { value in
                    Task { @MainActor in self.uploading?.progress = value }
                }
            } catch {
                failures.append(error.localizedDescription)
            }
            uploading = (index + 1, items.count, 0)
        }
        if failures.isEmpty {
            app.show("Uploaded \(items.count) photo\(items.count == 1 ? "" : "s").", tone: .success)
        } else {
            app.show("Some uploads failed: \(Set(failures).joined(separator: "; "))", tone: .failure)
        }
        await load(app)
    }

    func child(_ name: String) -> String { path.isEmpty ? name : "\(path)/\(name)" }

    func run(_ app: AppModel, _ title: String, _ action: @escaping (FrameOSService) async throws -> String) async {
        guard let service = app.service else { return }
        await app.perform(title) { ActionOutcome(kind: .done, message: try await action(service)) }
        await load(app)
    }
}

/// The photo library (docs/photos.md): albums and photos, the same on both planes.
struct PhotosView: View {
    var body: some View {
        NavigationStack {
            PhotoFolderView(path: "")
        }
    }
}

struct PhotoFolderView: View {
    @Environment(AppModel.self) private var app
    let path: String
    @State private var model: PhotoFolderModel
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var newAlbum = false
    @State private var albumName = ""
    @State private var renaming: PhotoEntry?
    @State private var renameText = ""
    @State private var moving: PhotoEntry?
    @State private var playing: PhotoEntry?
    @State private var sharing: PhotoEntry?
    @State private var deleting: PhotoEntry?
    @State private var viewing: PhotoEntry?
    /// Larger tiles on an iPad: a phone's 104-point photos made nine
    /// columns of stamps there.
    @State private var width: CGFloat = 0

    var wide: Bool { width >= ReadableWidth.wide }

    init(path: String) {
        self.path = path
        _model = State(initialValue: PhotoFolderModel(path: path))
    }

    var folders: [PhotoEntry] { model.entries.filter(\.isFolder) }
    var photos: [PhotoEntry] { model.entries.filter { !$0.isFolder } }

    var body: some View {
        withSheets(withDialogs(base))
    }

    var base: some View {
        ScrollView {
            content.padding()
        }
        .measureWidth($width)
        .overlay { if model.loading && model.entries.isEmpty { ProgressView() } }
        .navigationTitle(path.isEmpty ? "Photos" : (path.split(separator: "/").last.map(String.init) ?? path))
        .task { await model.load(app) }
        .refreshable { await model.load(app) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) { addMenu }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $pickerItems, maxSelectionCount: 50,
                      matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                await model.upload(app, items)
                pickerItems = []
            }
        }
    }

    @ViewBuilder var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            statusRows
            if !folders.isEmpty { albumsGrid }
            if !photos.isEmpty { photosGrid }
            if model.entries.isEmpty && !model.loading && model.error == nil {
                ContentUnavailableView {
                    Label(path.isEmpty ? "No photos yet" : "Empty album", systemImage: "photo.stack")
                } description: {
                    Text(path.isEmpty ? "Make an album, add photos, and play it on a frame." : "Add photos to this album.")
                }
            }
        }
    }

    @ViewBuilder var statusRows: some View {
        if let uploading = model.uploading {
            ProgressView("Uploading \(uploading.done + 1) of \(uploading.total)", value: uploading.progress)
        }
        if let error = model.error {
            Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
        }
        if path.isEmpty, let status = model.status, let quota = status.quotaBytes, quota > 0 {
            ProgressView("\(byteWords(status.usedBytes)) of \(byteWords(quota)) used", value: Double(status.usedBytes), total: Double(quota))
                .font(.caption)
        }
    }

    var albumsGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Albums").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: wide ? 190 : 150), spacing: wide ? 16 : 12, alignment: .top)],
                      spacing: wide ? 16 : 12) {
                ForEach(folders) { folder in
                    NavigationLink {
                        PhotoFolderView(path: folder.path)
                    } label: {
                        AlbumTile(entry: folder)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { folderMenu(folder) }
                }
            }
        }
    }

    var photosGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !folders.isEmpty { Text("Photos").font(.headline) }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: wide ? 150 : 104), spacing: 4)], spacing: 4) {
                ForEach(photos) { photo in
                    Button { viewing = photo } label: {
                        PhotoThumb(entry: photo).aspectRatio(1, contentMode: .fill)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { photoMenu(photo) }
                }
            }
        }
    }

    var thisFolder: PhotoEntry {
        PhotoEntry(raw: ["path": .string(path), "kind": "folder", "name": .string(path)])
    }

    var addMenu: some View {
        Menu {
            // A plain button: a PhotosPicker inside a Menu did not open on iOS 27 (the UI tour found it).
            Button { pickingPhotos = true } label: { Label("Add photos", systemImage: "photo.badge.plus") }
            Button { newAlbum = true } label: { Label("New album", systemImage: "folder.badge.plus") }
            if !path.isEmpty {
                Divider()
                Button { playing = thisFolder } label: { Label("Play on a frame", systemImage: "play.rectangle") }
                Button { sharing = thisFolder } label: { Label("Share links", systemImage: "link") }
            }
        } label: {
            Image(systemName: "plus").accessibilityLabel("Add")
        }
    }

    func createAlbum() {
        let name = albumName.trimmingCharacters(in: .whitespaces)
        albumName = ""
        guard !name.isEmpty else { return }
        let target = model.child(name)
        Task { await model.run(app, "New album") { _ = try await $0.createAlbum(target); return "Created \(name)." } }
    }

    func renameChosen() {
        guard let entry = renaming else { return }
        let name = renameText.trimmingCharacters(in: .whitespaces)
        renaming = nil
        Task { await model.run(app, "Rename") { try await $0.renamePhoto(entry.path, to: name); return "Renamed." } }
    }

    func deleteChosen() {
        guard let entry = deleting else { return }
        Task { await model.run(app, "Delete") { try await $0.deletePhotos([entry.path]); return "Deleted \(entry.name)." } }
    }

    func withDialogs<V: View>(_ view: V) -> some View {
        view
            .alert("New album", isPresented: $newAlbum) {
                TextField("Name", text: $albumName)
                Button("Cancel", role: .cancel) { albumName = "" }
                Button("Create") { createAlbum() }
            }
            .alert("Rename", isPresented: Binding { renaming != nil } set: { if !$0 { renaming = nil } }) {
                TextField("Name", text: $renameText)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Rename") { renameChosen() }
            }
            .confirmationDialog("Delete \(deleting?.name ?? "")?",
                                isPresented: Binding { deleting != nil } set: { if !$0 { deleting = nil } },
                                titleVisibility: .visible) {
                Button("Delete", role: .destructive) { deleteChosen() }
            } message: {
                Text(deleting?.isFolder == true
                    ? "The album, every photo in it and its share links go. A frame playing it shows that."
                    : "A frame playing this album stops showing the photo.")
            }
    }

    func withSheets<V: View>(_ view: V) -> some View {
        view
            .sheet(item: $moving) { entry in
                MovePhotoSheet(entry: entry) { await model.load(app) }
            }
            .sheet(item: $playing) { entry in
                PlayAlbumSheet(path: entry.path)
            }
            .sheet(item: $sharing) { entry in
                ShareLinksSheet(path: entry.path)
            }
            // The whole screen: an iPad's sheet showed the photo as a small
            // card with black bars above and below it.
            .fullScreenSheet(item: $viewing) { entry in
                PhotoViewer(entry: entry) { await model.load(app) }
            }
    }

    @ViewBuilder func folderMenu(_ folder: PhotoEntry) -> some View {
        Button { playing = folder } label: { Label("Play on a frame", systemImage: "play.rectangle") }
        Button { sharing = folder } label: { Label("Share links", systemImage: "link") }
        Button { renameText = folder.name; renaming = folder } label: { Label("Rename", systemImage: "pencil") }
        Button { moving = folder } label: { Label("Move", systemImage: "folder") }
        Button(role: .destructive) { deleting = folder } label: { Label("Delete", systemImage: "trash") }
    }

    @ViewBuilder func photoMenu(_ photo: PhotoEntry) -> some View {
        Button { renameText = photo.name; renaming = photo } label: { Label("Rename", systemImage: "pencil") }
        Button { moving = photo } label: { Label("Move", systemImage: "folder") }
        Button(role: .destructive) { deleting = photo } label: { Label("Delete", systemImage: "trash") }
    }
}

struct PhotoThumb: View {
    @Environment(AppModel.self) private var app
    let entry: PhotoEntry

    var body: some View {
        let service = app.service
        Color.clear
            .overlay {
                RemoteImage(key: "thumb:\(app.current?.id ?? ""):\(entry.path)@\(entry.version)", load: {
                    guard let service else { throw CancellationError() }
                    do {
                        return try await service.photoThumbnail(entry.path, version: entry.version)
                    } catch let error as APIError where error.status == 404 {
                        return try await service.photoFile(entry.path)
                    }
                }, contentMode: .fill, placeholder: { Rectangle().fill(.quaternary) })
            }
            .clipped()
            .overlay(alignment: .bottomTrailing) {
                if entry.hasLocation {
                    Image(systemName: "mappin.circle.fill").font(.caption).foregroundStyle(.white).shadow(radius: 2).padding(4)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            // One element: the photo's name, and whether it carries a location.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(entry.name)
            .accessibilityValue(entry.hasLocation ? "has a location" : "")
            .accessibilityAddTraits(.isImage)
    }
}

struct AlbumTile: View {
    let entry: PhotoEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let cover = entry.cover {
                    PhotoThumb(entry: PhotoEntry(raw: ["path": .string(cover), "kind": "file"]))
                } else {
                    ZStack {
                        RoundedRectangle(cornerRadius: 8).fill(.quaternary)
                        Image(systemName: "photo.stack").font(.title).foregroundStyle(.secondary)
                    }
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityHidden(true) // the cover: the album's name says it
            Text(entry.name).font(.subheadline.weight(.medium)).lineLimit(1)
            Text("\(entry.files) photo\(entry.files == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// Move a photo or an album into another album.
struct MovePhotoSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let entry: PhotoEntry
    let done: () async -> Void
    @State private var folders: [String] = []
    @State private var target = ""

    var body: some View {
        NavigationStack {
            List {
                Picker("Move to", selection: $target) {
                    Text("Photos (the top)").tag("")
                    ForEach(folders, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.inline)
            }
            .navigationTitle("Move \(entry.name)")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton {
                        guard let service = app.service else { return }
                        let destination = target
                        await app.perform("Move") {
                            try await service.movePhotos([entry.path], to: destination)
                            return ActionOutcome(kind: .done, message: "Moved.")
                        }
                        await done()
                        dismiss()
                    } label: { Text("Move") }
                }
            }
            .task { await loadFolders() }
        }
    }

    /// Every album, two levels deep (enough for a phone's picker).
    func loadFolders() async {
        guard let service = app.service else { return }
        var found: [String] = []
        let top = (try? await service.photos(in: "")) ?? []
        for folder in top where folder.isFolder {
            found.append(folder.path)
            let inner = (try? await service.photos(in: folder.path)) ?? []
            found.append(contentsOf: inner.filter(\.isFolder).map(\.path))
        }
        folders = found.filter { $0 != entry.path && !$0.hasPrefix(entry.path + "/") }
    }
}

/// "Play on a frame": the album as a scene on a frame.
struct PlayAlbumSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let path: String
    @State private var frameId: String?
    @State private var options = AlbumOptions()
    @State private var activate = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Frame", selection: $frameId) {
                        Text("Choose a frame").tag(String?.none)
                        ForEach(FrameGroups.byStatus(app.frames)) { group in
                            Section(group.label) {
                                ForEach(group.frames) { Text($0.displayName).tag(Optional($0.id)) }
                            }
                        }
                    }
                    Toggle("Show it now", isOn: $activate)
                }
                Section {
                    Picker("Each photo for", selection: $options.seconds) {
                        Text("1 minute").tag(60.0)
                        Text("5 minutes").tag(300.0)
                        Text("15 minutes").tag(900.0)
                        Text("1 hour").tag(3600.0)
                        Text("6 hours").tag(21600.0)
                        Text("1 day").tag(86400.0)
                    }
                    Picker("Order", selection: $options.order) {
                        Text("Random").tag("random")
                        Text("In order").tag("sequential")
                        Text("Newest first").tag("newest")
                        Text("Oldest first").tag("oldest")
                    }
                    Picker("Fit", selection: $options.fit) {
                        Text("Fill the screen").tag("cover")
                        Text("Whole photo").tag("contain")
                    }
                } footer: {
                    Text("The frame plays the album through its own share link and shows what the album holds at each change.")
                }
                Section {
                    AsyncButton {
                        guard let service = app.service, let id = frameId, let frame = app.frame(id) else { return }
                        let opts = options, show = activate
                        var ok = false
                        await app.perform("Play album") {
                            let outcome = try await service.installAlbum(path, on: frame, options: opts, activate: show)
                            ok = true
                            return outcome
                        }
                        if ok { dismiss() }
                    } label: { Text("Play on frame").frame(maxWidth: .infinity).fontWeight(.semibold) }
                    .disabled(frameId == nil)
                }
            }
            .navigationTitle("Play \(path.split(separator: "/").last.map(String.init) ?? path)")
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { if app.frames.count == 1 { frameId = app.frames.first?.id } }
        }
    }
}

/// The album's share links: the URLs frames (and people) read it through.
struct ShareLinksSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let path: String
    @State private var shares: [PhotoShare] = []
    @State private var name = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(shares) { share in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(label(share)).font(.subheadline.weight(.medium))
                            Text(app.service?.shareURL(share) ?? share.url).font(.caption.monospaced()).foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        .swipeActions {
                            Button("Delete", role: .destructive) {
                                Task {
                                    try? await app.service?.deleteShare(share)
                                    await load()
                                }
                            }
                            Button("Copy") { Pasteboard.copy(app.service?.shareURL(share) ?? share.url) }
                        }
                    }
                    if shares.isEmpty { Text("No links yet.").foregroundStyle(.secondary) }
                } footer: {
                    Text("Anyone with a link can see the album. Delete a link and frames using it stop showing the album.")
                }
                Section {
                    TextField("Name for a new link", text: $name)
                    AsyncButton {
                        _ = try? await app.service?.createShare(path: path, name: name.isEmpty ? "Shared from iOS" : name)
                        name = ""
                        await load()
                    } label: { Label("Create link", systemImage: "link.badge.plus") }
                }
            }
            .navigationTitle("Share links")
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    func label(_ share: PhotoShare) -> String {
        if let frameId = share.frameId, let frame = app.frame(frameId) { return "Frame: \(frame.displayName)" }
        if let name = share.name, !name.isEmpty { return name }
        return "Album link"
    }

    func load() async {
        shares = ((try? await app.service?.photoShares()) ?? []).filter { $0.path == path }
    }
}

/// One photo, large, with what the file says about itself.
struct PhotoViewer: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let entry: PhotoEntry
    let changed: () async -> Void
    @State private var image: PlatformImage?
    @State private var showInfo = false

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    Image(platformImage: image).resizable().scaledToFit()
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
            .navigationTitle(entry.name)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { showInfo = true } label: { Image(systemName: "info.circle") }.accessibilityLabel("Info")
                }
            }
            .task {
                guard let service = app.service, let data = try? await service.photoFile(entry.path) else { return }
                image = PlatformImage(data: data)
            }
            .sheet(isPresented: $showInfo) {
                PhotoInfoSheet(entry: entry, changed: changed)
            }
        }
    }
}

struct PhotoInfoSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let entry: PhotoEntry
    let changed: () async -> Void
    @State private var metadata: JSONValue?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Size", value: byteWords(entry.size))
                    if let width = entry.width, let height = entry.height { LabeledContent("Pixels", value: "\(width) × \(height)") }
                    if let type = entry.contentType { LabeledContent("Type", value: type) }
                    if entry.colors != nil { LabeledContent("Color profile", value: "set (edit it on the web)") }
                }
                if let location = metadata?["location"], !location.isNull {
                    Section("Location") {
                        Text("\(location["latitude"]?.doubleValue ?? 0, specifier: "%.5f"), \(location["longitude"]?.doubleValue ?? 0, specifier: "%.5f")")
                        AsyncButton(role: .destructive) {
                            await remove(everything: false)
                        } label: { Text("Remove the location") }
                    }
                }
                if let fields = metadata?["fields"]?.arrayValue, !fields.isEmpty {
                    Section {
                        ForEach(Array(fields.prefix(40).enumerated()), id: \.offset) { _, field in
                            LabeledContent(field["name"]?.stringValue ?? "", value: field["value"]?.stringValue ?? "")
                        }
                        AsyncButton(role: .destructive) {
                            await remove(everything: true)
                        } label: { Text("Remove all metadata") }
                    } header: {
                        Text("In the file")
                    } footer: {
                        Text("The photo is kept exactly as uploaded. Removing metadata rewrites the file.")
                    }
                }
            }
            .navigationTitle("Info")
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { metadata = try? await app.service?.photoMetadata(entry.path) }
        }
    }

    func remove(everything: Bool) async {
        guard let service = app.service else { return }
        await app.perform("Remove metadata") {
            try await service.removePhotoMetadata([entry.path], everything: everything)
            return ActionOutcome(kind: .done, message: everything ? "Metadata removed." : "Location removed.")
        }
        metadata = try? await service.photoMetadata(entry.path)
        await changed()
    }
}
