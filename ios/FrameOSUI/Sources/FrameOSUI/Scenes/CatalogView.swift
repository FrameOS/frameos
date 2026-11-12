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
        // The store's shelves in shelf order (the SPA's Add scene drawer),
        // anything else (a repository, My scenes) as it came.
        let ranked = order.enumerated().sorted { a, b in
            let (rankA, rankB) = (StoreCategories.rank(ofTitle: a.element), StoreCategories.rank(ofTitle: b.element))
            return rankA != rankB ? rankA < rankB : a.offset < b.offset
        }
        return ranked.map { ($0.element, byGroup[$0.element]!) }
    }
}

/// "Scenes": browse and install. As a tab it picks the frame at install
/// time; from a frame page ("Add scene") it installs on that frame.
struct CatalogView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var installTarget: Frame?
    var onInstalled: (() -> Void)?
    /// From a frame with no layout yet: "Add layout" (the SPA's drawer has it
    /// while the frame has none).
    var addLayout: ((LayoutStarter) async -> Void)?
    @State private var model = CatalogModel()
    @State private var chosen: CatalogItem?
    /// An iPad (or its larger sheet) shows the store as a grid of covers:
    /// rows across its width were a line of text beside a thumbnail.
    @State private var width: CGFloat = 0

    var grid: Bool { width >= ReadableWidth.wide }

    var body: some View {
        NavigationStack {
            Group {
                if grid { cards } else { rows }
            }
            .measureWidth($width)
            .overlay { if model.loading && model.items.isEmpty { ProgressView() } }
            .searchable(text: $model.query, prompt: "Search scenes")
            .scrollDismissesKeyboard(.immediately)
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

    /// A phone: the shelves as list sections, a row per scene.
    var rows: some View {
        List {
            // From a frame page, the web drawer's first actions: here
            // only Generate scene (no editor in the app).
            if let target = installTarget {
                Section {
                    NavigationLink {
                        generateScene(target)
                    } label: { GenerateSceneLabel() }
                    if addLayout != nil {
                        NavigationLink {
                            layoutStarters
                        } label: { AddLayoutLabel() }
                    }
                }
            }
            storeOrSaved
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            }
            ForEach(model.groups, id: \.0) { group, items in
                Section(group) {
                    ForEach(items) { item in
                        Button {
                            choose(item)
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
            if showsEmpty { emptyText }
        }
    }

    /// An iPad: the shelves as headed grids of covers.
    var cards: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let target = installTarget {
                    HStack(spacing: 12) {
                        NavigationLink {
                            generateScene(target)
                        } label: { ActionCard { GenerateSceneLabel() } }
                        if addLayout != nil {
                            NavigationLink {
                                layoutStarters
                            } label: { ActionCard { AddLayoutLabel() } }
                        }
                    }
                    .buttonStyle(.plain)
                }
                storeOrSaved.frame(maxWidth: 360)
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 16, alignment: .top)],
                          alignment: .leading, spacing: 16) {
                    ForEach(model.groups, id: \.0) { group, items in
                        Section {
                            ForEach(items) { item in
                                Button {
                                    choose(item)
                                } label: {
                                    CatalogCard(item: item)
                                }
                                .buttonStyle(.plain)
                            }
                        } header: {
                            Text(group)
                                .font(.title3.weight(.semibold))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 12)
                        }
                    }
                }
                if model.hasMore {
                    ProgressView().frame(maxWidth: .infinity).task { await model.loadMore(app) }
                }
                if showsEmpty { emptyText }
            }
            .padding()
        }
    }

    /// Both planes: the store (its shelves) or the account's own saved
    /// scenes (the cloud's My scenes, a backend's templates).
    var storeOrSaved: some View {
        Picker("Scenes", selection: $model.mine) {
            Text("Store").tag(false)
            Text("Saved").tag(true)
        }
        .pickerStyle(.segmented)
    }

    var showsEmpty: Bool { model.items.isEmpty && !model.loading && model.error == nil }

    var emptyText: some View {
        Text(model.query.isEmpty
            ? (model.mine ? "No saved scenes yet. Save one in the web editor and it shows here." : "Nothing here yet.")
            : "No scenes match \"\(model.query)\".")
            .foregroundStyle(.secondary)
    }

    func generateScene(_ target: Frame) -> some View {
        ChatView(frameId: target.id, chatId: nil, generating: true)
    }

    var layoutStarters: some View {
        LayoutStartersView { starter in
            await addLayout?(starter)
            dismiss()
        }
    }

    func choose(_ item: CatalogItem) {
        hideKeyboard()
        chosen = item
    }
}

/// "Add layout" in the Add scene sheet, while the frame has none.
struct AddLayoutLabel: View {
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Add layout")
                Text("Drawn around your scenes, like a bar with the clock").font(.caption).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "rectangle.inset.topleft.filled").foregroundStyle(.tint)
        }
    }
}

/// A row's action as a card, above a grid.
struct ActionCard<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack {
            content()
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.quaternary))
        .contentShape(Rectangle())
    }
}

/// One scene in the store's grid: its cover, name, what it does, who made it.
struct CatalogCard: View {
    let item: CatalogItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // The store's covers are 4:3 (800 x 600).
            Color.clear
                .aspectRatio(4.0 / 3.0, contentMode: .fit)
                .overlay { CatalogImage(item: item) }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.quaternary))
            VStack(alignment: .leading, spacing: 3) {
                Text(item.name).font(.headline).lineLimit(1)
                // Two lines kept for every card, so a row of cards is one height.
                Text(item.description).font(.caption).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                if let author = item.author, !author.isEmpty {
                    Text(author).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            .padding(.horizontal, 4)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.quaternary))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
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
    @State private var reporting = false
    @State private var reportReason = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // At most 220 points tall: at an iPad sheet's width the
                    // cover alone was most of the sheet.
                    FittedBox(aspect: 4.0 / 3.0, maxHeight: 220) {
                        Color.clear
                            .overlay { CatalogImage(item: item) }
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                    // One row under the cover, so the frame and Show it now
                    // are on an iPad's sheet without scrolling.
                    if !item.description.isEmpty || !byline.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            if !item.description.isEmpty { Text(item.description) }
                            if !byline.isEmpty { Text(byline).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
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
                            // The frames list's order: Active, Inactive, Archived.
                            ForEach(FrameGroups.byStatus(app.frames)) { group in
                                Section(group.label) {
                                    ForEach(group.frames) { frame in
                                        Text(frame.displayName).tag(Optional(frame.id))
                                    }
                                }
                            }
                        }
                    }
                    Toggle("Show it now", isOn: $activate)
                } footer: {
                    Text(app.current?.kind == .backend
                        ? "The scene is added to the frame's list and deployed."
                        : "The scene is added to the frame's list and pushed; a sleeping frame gets it when it wakes.")
                }
                if case .cloudStore(let storeSceneId) = item.source {
                    // Other people's scenes (App Store guideline 1.2): the
                    // store's report queue, as on the web.
                    Section {
                        Button(role: .destructive) { reporting = true } label: {
                            Label("Report this scene", systemImage: "flag")
                        }
                    }
                    .alert("Report this scene", isPresented: $reporting) {
                        TextField("What is wrong with it?", text: $reportReason)
                        Button("Cancel", role: .cancel) { reportReason = "" }
                        Button("Report") { report(storeSceneId) }
                    } message: {
                        Text("Reports go to the FrameOS team, who remove scenes that break the store's rules.")
                    }
                }
            }
            // Always on screen: at the end of the form it was below the
            // bottom of an iPad's sheet.
            .safeAreaInset(edge: .bottom) {
                AsyncButton {
                    await install()
                } label: {
                    Text(activate ? "Install & activate" : "Install on frame").frame(maxWidth: .infinity).fontWeight(.semibold)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(selectedFrame == nil)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(.bar)
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

    /// "By Marius Andra · calendar"
    var byline: String {
        var parts: [String] = []
        if let author = item.author, !author.isEmpty { parts.append("By \(author)") }
        if let category = item.category, !category.isEmpty { parts.append(category) }
        return parts.joined(separator: " · ")
    }

    func report(_ storeSceneId: String) {
        let reason = reportReason.trimmingCharacters(in: .whitespacesAndNewlines)
        reportReason = ""
        guard let service = app.service else { return }
        Task {
            await app.perform("Report") {
                try await service.reportStoreScene(storeSceneId, reason: reason.isEmpty ? "Reported from the iOS app." : reason)
                return ActionOutcome(kind: .done, message: "Reported. Thank you.")
            }
        }
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
            // The new scene's picture (on a backend, the cover the install
            // copied): a row that drew the placeholder first loads it again.
            app.imageVersions[frame.id, default: 0] += 1
            await app.reloadFrame(frame.id)
            dismiss()
            onInstalled()
        }
    }
}
