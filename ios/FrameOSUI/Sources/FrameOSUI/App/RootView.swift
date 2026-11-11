import FrameOSKit
import SwiftUI

/// The app's first view: the sign-in screen until an account is signed in,
/// then the tabs. The app target's entry point shows only this.
public struct RootView: View {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
        Group {
            if app.restoring {
                ProgressView().controlSize(.large)
            } else if app.current == nil {
                SignInView()
            } else {
                MainTabs()
            }
        }
        .environment(app)
        .tint(Brand.teal)
        .task { await app.restore() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: app.resumeLive()
            case .background: app.pauseLive()
            default: break
            }
        }
        .overlay(alignment: .bottom) {
            if let notice = app.notice {
                NoticeBanner(notice: notice)
                    .padding(.bottom, 60)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onTapGesture { app.notice = nil }
                    .task(id: notice.id) {
                        try? await Task.sleep(nanoseconds: 4_500_000_000)
                        if app.notice?.id == notice.id { withAnimation { app.notice = nil } }
                    }
            }
        }
        .animation(.spring(duration: 0.3), value: app.notice)
        .sheet(item: Binding(get: { app.reauth }, set: { app.reauth = $0 })) { request in
            ReauthSheet(request: request)
        }
    }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        TabView {
            FramesListView()
                .tabItem { Label("Frames", systemImage: "photo.on.rectangle") }
            CatalogView()
                .tabItem { Label("Scenes", systemImage: "square.grid.2x2") }
            PhotosView()
                .tabItem { Label("Photos", systemImage: "photo.stack") }
            ChatListView()
                .tabItem { Label("AI", systemImage: "sparkles") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .id(app.current?.id)
    }
}
