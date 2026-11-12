// swift-tools-version:6.0
// FrameOSKit: everything the iOS app does that is not a screen — the two
// control planes' clients, the models, the readers of the repo's contracts —
// with the tests that replay the repo's fixture corpora (docs/*-fixtures.json).
// It builds and tests on a Mac without Xcode (`ios/bin/test`).
import PackageDescription

let package = Package(
    name: "FrameOSKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "FrameOSKit", targets: ["FrameOSKit"]),
    ],
    targets: [
        // LayoutStarters.json: written by frontend/scripts/generateLayoutStarters.mjs.
        .target(name: "FrameOSKit", resources: [.copy("Generated/LayoutStarters.json")]),
        .testTarget(name: "FrameOSKitTests", dependencies: ["FrameOSKit"]),
    ],
    swiftLanguageModes: [.v5]
)
