import FrameOSKit
import SwiftUI

struct FramesListView: View {
    @Environment(AppModel.self) private var app
    @State private var search = ""
    /// Large cards or a compact list, as the person left it.
    @AppStorage("frames.layout") private var layout = "cards"

    /// The website's order: Active, Inactive, Archived, each by name
    /// (FrameGroups, pinned to the SPA by docs/frame-status-fixtures.json).
    var groups: [FrameGroups.Group] {
        let matching = search.isEmpty ? app.frames : app.frames.filter { $0.displayName.localizedCaseInsensitiveContains(search) }
        return FrameGroups.byStatus(matching)
    }

    var body: some View {
        NavigationStack {
            Group {
                if app.frames.isEmpty && app.framesLoading {
                    ProgressView("Loading frames")
                } else if app.frames.isEmpty {
                    ContentUnavailableView {
                        Label(app.framesError == nil ? "No frames yet" : "Could not load frames", systemImage: "photo.on.rectangle")
                    } description: {
                        Text(app.framesError ?? emptyHint)
                    } actions: {
                        AsyncButton { await app.refreshFrames() } label: { Text("Try again") }
                    }
                } else if layout == "list" {
                    List {
                        ForEach(groups) { group in
                            Section(group.label) {
                                ForEach(group.frames) { frame in
                                    NavigationLink(value: frame.id) { FrameRow(frame: frame) }
                                }
                            }
                        }
                    }
                    .searchable(text: $search, prompt: "Search frames")
                } else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 16)], alignment: .leading, spacing: 16) {
                            ForEach(groups) { group in
                                Section {
                                    ForEach(group.frames) { frame in
                                        NavigationLink(value: frame.id) {
                                            FrameCard(frame: frame)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                } header: {
                                    Text(group.label)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.top, 4)
                                }
                            }
                        }
                        .padding()
                    }
                    .searchable(text: $search, prompt: "Search frames")
                }
            }
            .refreshable { await app.refreshFrames() }
            .navigationTitle("Frames")
            .navigationDestination(for: String.self) { id in
                FrameDetailView(frameId: id)
            }
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        withAnimation { layout = layout == "list" ? "cards" : "list" }
                    } label: {
                        Image(systemName: layout == "list" ? "square.grid.2x2" : "list.bullet")
                    }
                    .accessibilityLabel(layout == "list" ? "Show as cards" : "Show as a list")
                    AccountMenu()
                }
            }
        }
    }

    var emptyHint: String {
        app.current?.kind == .cloud
            ? "Add a frame from the web at cloud.frameos.net: flash or link it there, and it shows up here."
            : "Add a frame in the backend's web workspace, and it shows up here."
    }
}

/// One frame in the compact list: a small picture, its name, its status.
struct FrameRow: View {
    let frame: Frame

    var body: some View {
        HStack(spacing: 12) {
            FrameImageView(frame: frame)
                .frame(width: 72)
            VStack(alignment: .leading, spacing: 3) {
                Text(frame.displayName).font(.body.weight(.medium)).lineLimit(1)
                FrameStatusLine(frame: frame)
            }
        }
        .padding(.vertical, 2)
    }
}

/// One frame on the list: its picture, name and what it is doing.
struct FrameCard: View {
    let frame: Frame

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            FrameImageView(frame: frame)
            VStack(alignment: .leading, spacing: 4) {
                Text(frame.displayName).font(.headline).lineLimit(1)
                FrameStatusLine(frame: frame)
            }
            .padding(.horizontal, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.quaternary))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Which account is showing, and a quick switch to another.
struct AccountMenu: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Menu {
            ForEach(app.accounts) { account in
                Button {
                    app.activate(account)
                } label: {
                    if account.id == app.current?.id {
                        Label("\(account.planeLabel) · \(account.email)", systemImage: "checkmark")
                    } else {
                        Text("\(account.planeLabel) · \(account.email)")
                    }
                }
            }
        } label: {
            Image(systemName: app.current?.kind == .backend ? "server.rack" : "cloud")
                .accessibilityLabel("Account: \(app.current?.planeLabel ?? "")")
        }
    }
}
