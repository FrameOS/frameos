import Foundation
@testable import FrameOSKit

/// The repo's shared corpora live in docs/: the tests read them straight
/// from the checkout, the way every other plane's runner does, so a corpus
/// change reaches the Swift ports without a copy.
enum RepoFixtures {
    static var repoRoot: URL {
        // ios/FrameOSKit/Tests/FrameOSKitTests/<file> → the repo root.
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    static func json(_ relativePath: String) throws -> JSONValue {
        let data = try Data(contentsOf: repoRoot.appendingPathComponent(relativePath))
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    static func data(_ relativePath: String) throws -> Data {
        try Data(contentsOf: repoRoot.appendingPathComponent(relativePath))
    }
}
