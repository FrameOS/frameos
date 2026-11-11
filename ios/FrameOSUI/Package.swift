// swift-tools-version:6.0
// FrameOSUI: the app's screens (SwiftUI). A package of its own so it can be
// type-checked for macOS without Xcode (`ios/bin/check-ui`); the app target
// in ../FrameOS is only the entry point.
import PackageDescription

let package = Package(
    name: "FrameOSUI",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "FrameOSUI", targets: ["FrameOSUI"]),
    ],
    dependencies: [
        .package(path: "../FrameOSKit"),
    ],
    targets: [
        .target(name: "FrameOSUI", dependencies: [.product(name: "FrameOSKit", package: "FrameOSKit")]),
    ],
    swiftLanguageModes: [.v5]
)
