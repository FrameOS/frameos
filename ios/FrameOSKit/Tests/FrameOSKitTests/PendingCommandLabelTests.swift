import Foundation
import Testing
@testable import FrameOSKit

/// The pending-command words are a copy of the SPA's table: this reads the
/// SPA's source and compares, so the two lists cannot drift.
@Suite struct PendingCommandLabelTests {
    @Test func labelsMatchTheSPA() throws {
        let source = try String(decoding: RepoFixtures.data("frontend/src/scenes/workspace/framePendingCommandsLogic.ts"), as: UTF8.self)
        let start = try #require(source.range(of: "const commandLabels: Record<string, string> = {"))
        let end = try #require(source.range(of: "\n}", range: start.upperBound..<source.endIndex))
        let body = source[start.upperBound..<end.lowerBound]
        var spa: [String: String] = [:]
        let pattern = try NSRegularExpression(pattern: #"^\s*([a-z_]+):\s*(['"])(.*)\2,?\s*$"#, options: [.anchorsMatchLines])
        let text = String(body)
        for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            let key = String(text[Range(match.range(at: 1), in: text)!])
            let value = String(text[Range(match.range(at: 3), in: text)!])
            spa[key] = value
        }
        #expect(spa.count >= 10)
        #expect(spa == PendingCommand.labels)
    }
}
