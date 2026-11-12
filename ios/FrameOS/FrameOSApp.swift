import FrameOSUI
import SwiftUI

/// The iOS app's entry point. Everything else lives in the two packages:
/// FrameOSKit (the control planes, the contracts) and FrameOSUI (the screens).
@main
struct FrameOSApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
