import FrameOSKit
import SwiftUI

// A frame's layouts (docs/scene-layouts.md), as the SPA's Layouts settings
// have them (layoutsSection.tsx, SceneSettings' Layout select): one layout
// for every scene or each its own, a layout's settings for the scenes that
// wear it, and the starters to add one from.

private let differentLayouts = "\u{1}different"

/// Under Scenes on the frame page, when the frame has a layout.
struct FrameLayoutsSection: View {
    @Environment(AppModel.self) private var app
    let frameId: String
    let model: FrameDetailModel
    @Binding var addingLayout: Bool

    var body: some View {
        Section {
            Picker("Layout", selection: Binding {
                model.commonLayoutId ?? differentLayouts
            } set: { id in
                guard id != differentLayouts else { return }
                Task { await model.setLayoutForEveryScene(app, id) }
            }) {
                if model.commonLayoutId == nil {
                    Text("Different layouts").tag(differentLayouts)
                }
                Text("No layout").tag("")
                ForEach(model.layouts) { layout in
                    Text(layout.name).tag(layout.id)
                }
            }
            ForEach(model.layouts) { layout in
                NavigationLink {
                    LayoutDetailView(frameId: frameId, layoutId: layout.id, model: model)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(layout.name)
                        Text(wornWords(layout)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Button {
                addingLayout = true
            } label: {
                Label("New layout", systemImage: "plus.rectangle.on.rectangle")
            }
        } header: {
            Text("Layouts")
        } footer: {
            Text("A layout is drawn around the scenes that wear it, like a bar with the clock. Pick one for every scene here, or each scene's own in its settings.")
        }
    }

    func wornWords(_ layout: InstalledScene) -> String {
        let wearing = model.scenesWearing(layout).count
        let total = model.listedScenes.count
        if wearing == 0 { return "Not on any scene" }
        if wearing == total { return total == 1 ? "On the scene" : "On every scene" }
        return "On \(wearing) of \(total) scenes"
    }
}

/// One layout: which scenes wear it, its settings for them, and Remove.
struct LayoutDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let frameId: String
    let layoutId: String
    let model: FrameDetailModel
    @State private var confirmRemove = false

    var body: some View {
        if let layout = model.layouts.first(where: { $0.id == layoutId }) {
            let wearing = model.scenesWearing(layout)
            Form {
                if let description = layout.scene["description"]?.stringValue ?? starterDescription(layout), !description.isEmpty {
                    Section { Text(description).font(.callout) }
                }
                Section {
                    if wearing.isEmpty {
                        Text("No scene wears it yet.").foregroundStyle(.secondary)
                    } else {
                        ForEach(wearing) { scene in Text(scene.name) }
                    }
                    if wearing.count < model.listedScenes.count {
                        AsyncButton {
                            await model.setLayoutForEveryScene(app, layout.id)
                        } label: {
                            Label("Put on every scene", systemImage: "rectangle.stack")
                        }
                    }
                } header: {
                    Text("Worn by")
                }
                if !layout.fields.isEmpty {
                    Section {
                        NavigationLink {
                            LayoutSettingsView(model: model, layout: layout, scenes: wearing,
                                               title: wearing.count > 1 ? "For every scene wearing it" : nil)
                        } label: {
                            Label("Settings", systemImage: "slider.horizontal.3")
                        }
                        .disabled(wearing.isEmpty)
                    } footer: {
                        Text(wearing.isEmpty
                            ? "Its settings live with the scenes that wear it: put it on one first."
                            : "Each scene can also have its own, in that scene's settings.")
                    }
                }
                Section {
                    Button(role: .destructive) {
                        confirmRemove = true
                    } label: {
                        Label("Remove from frame", systemImage: "trash")
                    }
                }
            }
            .navigationTitle(layout.name)
            .inlineTitle()
            .confirmationDialog("Remove \(layout.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    Task {
                        await model.remove(app, layout)
                        dismiss()
                    }
                }
            } message: {
                Text("The scenes that wear it are drawn without a layout.")
            }
        } else {
            ContentUnavailableView("This layout is gone", systemImage: "rectangle.dashed")
        }
    }

    func starterDescription(_ layout: InstalledScene) -> String? {
        LayoutStarters.all.first { $0.name == layout.name }?.description
    }
}

/// A layout's fields, saved as `layout.state` on the scenes given.
struct LayoutSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: FrameDetailModel
    let layout: InstalledScene
    let scenes: [InstalledScene]
    var title: String?
    @State private var draft: [String: JSONValue] = [:]
    @State private var seeded = false

    var fields: [SceneField] { SceneForm.visiblePublicFields(layout.fields, [draft]) }

    var body: some View {
        Form {
            Section {
                ForEach(fields) { field in
                    SceneFieldEditor(field: field, value: Binding {
                        draft[field.name] ?? field.defaultValue ?? .null
                    } set: {
                        draft[field.name] = $0
                    })
                }
            } header: {
                if let title { Text(title) }
            }
            Section {
                AsyncButton {
                    await model.saveLayoutSettings(app, layout: layout, scenes: scenes, state: draft)
                    dismiss()
                } label: {
                    Text("Save").frame(maxWidth: .infinity).fontWeight(.semibold)
                }
            } footer: {
                Text(app.current?.kind == .backend ? "Saved and deployed." : "The frame gets them when it next checks in.")
            }
        }
        .navigationTitle("\(layout.name) settings")
        .inlineTitle()
        .onAppear {
            guard !seeded else { return }
            seeded = true
            // What the first scene has: one form for all of them.
            if let first = scenes.first, let state = model.wornLayout(first)?["state"]?.objectValue {
                draft = state
            }
        }
    }
}

/// The starters (docs/scene-layouts.md "Starters"): the repo's layout samples.
struct LayoutStartersView: View {
    @Environment(\.dismiss) private var dismiss
    let add: (LayoutStarter) async -> Void

    var body: some View {
        List {
            Section {
                ForEach(LayoutStarters.all) { starter in
                    AsyncButton {
                        await add(starter)
                        dismiss()
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            starterImage(starter)
                                .frame(width: 96, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(starter.name).font(.body.weight(.medium)).foregroundStyle(.primary)
                                Text(starter.description).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } footer: {
                Text("Added to this frame. You can change its settings, or which scenes wear it, afterwards.")
            }
        }
        .navigationTitle("New layout")
        .inlineTitle()
    }

    @ViewBuilder func starterImage(_ starter: LayoutStarter) -> some View {
        if let data = starter.image, let image = PlatformImage(data: data) {
            Image(platformImage: image).resizable().scaledToFill()
        } else {
            ZStack {
                Rectangle().fill(.quaternary)
                Image(systemName: "rectangle.dashed").foregroundStyle(.secondary)
            }
        }
    }
}

/// In a scene's sheet: the layout it wears, and its settings for this scene.
struct SceneLayoutSection: View {
    @Environment(AppModel.self) private var app
    let scene: InstalledScene
    let model: FrameDetailModel

    var body: some View {
        // The list's copy: the sheet's own is from when it opened.
        let current = model.scenes.first { $0.id == scene.id } ?? scene
        let wornId = model.wornLayout(current)?["sceneId"]?.stringValue ?? ""
        Section {
            Picker("Layout", selection: Binding {
                wornId
            } set: { id in
                Task { await model.setLayout(app, for: current, id) }
            }) {
                Text("No layout").tag("")
                ForEach(model.layouts) { layout in
                    Text(layout.name).tag(layout.id)
                }
            }
            if let layout = model.layouts.first(where: { $0.id == wornId }), !layout.fields.isEmpty {
                NavigationLink {
                    LayoutSettingsView(model: model, layout: layout, scenes: [current], title: "For \(current.name)")
                } label: {
                    Label("Layout settings", systemImage: "slider.horizontal.3")
                }
            }
        } footer: {
            Text("Drawn around this scene. The frame's Layouts section sets it for every scene.")
        }
    }
}
