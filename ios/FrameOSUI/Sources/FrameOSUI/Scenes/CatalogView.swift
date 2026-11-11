import FrameOSKit
import Observation
import SwiftUI

/// The catalog's state: the cloud store (or the account's own scenes), or a
/// backend's saved scenes and repositories.
@Observable @MainActor
final class CatalogModel {
    var items: [CatalogItem] = []
    var query = ""
    var mine = false
    var page = 1
    var hasMore = false
    var loading = false
    var error: String?

    func load(_ app: AppModel, reset: Bool = true) async {
        guard let service = app.service else { return }
        if reset { page = 1 }
        loading = true
        defer { loading = false }
        do {
            let result = try await service.catalog(query: query, page: page, mine: mine)
            items = reset ? result.items : items + result.items
            hasMore = result.hasMore
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadMore(_ app: AppModel) async {
        guard hasMore, !loading else { return }
        page += 1
        await load(app, reset: false)
    }

    var groups: [(String, [CatalogItem])] {
        var order: [String] = []
        var byGroup: [String: [CatalogItem]] = [:]
        for item in items {
            if byGroup[item.group] == nil { order.append(item.group) }
            byGroup[item.group, default: []].append(item)
        }
        return order.map { ($0, byGroup[$0]!) }
    }
}

/// "Scenes": browse and install. As a tab it picks the frame at install
/// time; from a frame page ("Add scene") it installs on that frame.
struct CatalogView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var installTarget: Frame?
    var onInstalled: (() -> Void)?
    @State private var model = CatalogModel()
    @State private var chosen: CatalogItem?

    var body: some View {
        NavigationStack {
            List {
                if app.current?.kind == .cloud {
                    Picker("Source", selection: $model.mine) {
                        Text("Store").tag(false)
                        Text("My scenes").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                }
                ForEach(model.groups, id: \.0) { group, items in
                    Section(group) {
                        ForEach(items) { item in
                            Button {
                                chosen = item
                            } label: {
                                CatalogRow(item: item)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if model.hasMore {
                    ProgressView().frame(maxWidth: .infinity).task { await model.loadMore(app) }
                }
                if model.items.isEmpty && !model.loading && model.error == nil {
                    Text(model.query.isEmpty ? "Nothing here yet." : "No scenes match \"\(model.query)\".")
                        .foregroundStyle(.secondary)
                }
            }
            .overlay { if model.loading && model.items.isEmpty { ProgressView() } }
            .searchable(text: $model.query, prompt: "Search scenes")
            .onSubmit(of: .search) { Task { await model.load(app) } }
            .task(id: model.mine) { await model.load(app) }
            .task(id: model.query) {
                try? await Task.sleep(nanoseconds: 400_000_000)
                await model.load(app)
            }
            .refreshable { await model.load(app) }
            .navigationTitle(installTarget == nil ? "Scenes" : "Add scene")
            .inlineTitle()
            .toolbar {
                if installTarget != nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                }
            }
            .sheet(item: $chosen) { item in
                InstallSheet(item: item, target: installTarget) {
                    onInstalled?()
                    if installTarget != nil { dismiss() }
                }
            }
        }
    }
}

struct CatalogRow: View {
    @Environment(AppModel.self) private var app
    let item: CatalogItem

    var body: some View {
        HStack(spacing: 12) {
            CatalogImage(item: item)
                .frame(width: 72, height: 54)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.name).font(.body.weight(.medium)).lineLimit(1)
                if !item.description.isEmpty {
                    Text(item.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if let author = item.author, !author.isEmpty {
                    Text(author).font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .contentShape(Rectangle())
    }
}

struct CatalogImage: View {
    @Environment(AppModel.self) private var app
    let item: CatalogItem

    var body: some View {
        if let image = item.image {
            let client = app.service?.client
            RemoteImage(key: "catalog:\(image)", load: {
                if image.hasPrefix("http://") || image.hasPrefix("https://") {
                    if let client, let url = URL(string: image), url.host == client.account.baseURL.host {
                        var request = URLRequest(url: url)
                        client.authorize(&request, isWrite: false)
                        return try await client.send(request).0
                    }
                    return try await URLSession.shared.data(from: URL(string: image)!).0
                }
                guard let client else { throw CancellationError() }
                return try await client.bytes(image).0
            }, contentMode: .fill, placeholder: { Rectangle().fill(.quaternary) })
        } else {
            ZStack {
                Rectangle().fill(.quaternary)
                Image(systemName: "square.grid.2x2").foregroundStyle(.secondary)
            }
        }
    }
}

/// Install one catalog scene: on which frame, shown now or not.
struct InstallSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let item: CatalogItem
    let target: Frame?
    let onInstalled: () -> Void
    @State private var frameId: String?
    @State private var activate = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    CatalogImage(item: item)
                        .aspectRatio(4 / 3, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                    if !item.description.isEmpty { Text(item.description) }
                    if let category = item.category { LabeledContent("Category", value: category) }
                    if let author = item.author, !author.isEmpty { LabeledContent("By", value: author) }
                }
                if item.needsShell {
                    Section {
                        Label("This scene runs commands on the frame. Install it only if you trust where it comes from.",
                              systemImage: "exclamationmark.shield")
                            .foregroundStyle(.orange)
                    }
                }
                Section {
                    if target == nil {
                        Picker("Frame", selection: $frameId) {
                            Text("Choose a frame").tag(String?.none)
                            ForEach(app.frames) { frame in
                                Text(frame.displayName).tag(Optional(frame.id))
                            }
                        }
                    }
                    Toggle("Show it now", isOn: $activate)
                } footer: {
                    Text(app.current?.kind == .backend
                        ? "The scene is added to the frame's list and deployed."
                        : "The scene is added to the frame's list and pushed; a sleeping frame gets it when it wakes.")
                }
                Section {
                    AsyncButton {
                        await install()
                    } label: {
                        Text(activate ? "Install & activate" : "Install on frame").frame(maxWidth: .infinity).fontWeight(.semibold)
                    }
                    .disabled(selectedFrame == nil)
                }
            }
            .navigationTitle(item.name)
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { frameId = target?.id ?? (app.frames.count == 1 ? app.frames.first?.id : nil) }
        }
    }

    var selectedFrame: Frame? {
        target ?? frameId.flatMap { app.frame($0) }
    }

    func install() async {
        guard let frame = selectedFrame, let service = app.service else { return }
        var succeeded = false
        await app.perform("Install") {
            let outcome = try await service.install(item, on: frame, activate: activate)
            succeeded = true
            return outcome
        }
        if succeeded {
            await app.reloadFrame(frame.id)
            dismiss()
            onInstalled()
        }
    }
}
