import Foundation
import Testing
@testable import FrameOSKit

/// The store's shelves are a copy of the SPA's list: this reads the SPA's
/// source and compares slugs, titles and their order.
@Suite struct StoreCategoryTests {
    @Test func shelvesMatchTheSPA() throws {
        let source = try String(decoding: RepoFixtures.data("frontend/src/utils/storeCategories.ts"), as: UTF8.self)
        let start = try #require(source.range(of: "export const storeCategoryShelves: StoreCategoryShelf[] = ["))
        let end = try #require(source.range(of: "\n]", range: start.upperBound..<source.endIndex))
        let text = String(source[start.upperBound..<end.lowerBound])
        let pattern = try NSRegularExpression(pattern: #"\{\s*slug:\s*'([^']+)',\s*title:\s*'([^']+)'\s*\}"#)
        let spa = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { match in
            (String(text[Range(match.range(at: 1), in: text)!]), String(text[Range(match.range(at: 2), in: text)!]))
        }
        #expect(spa.count >= 10)
        #expect(spa.map(\.0) == StoreCategories.shelves.map(\.slug))
        #expect(spa.map(\.1) == StoreCategories.shelves.map(\.title))
        #expect(source.contains("{ slug: '\(StoreCategories.other.slug)', title: '\(StoreCategories.other.title)' }"))
    }

    @Test func unknownCategoriesGoToOther() {
        #expect(StoreCategories.shelf(for: " Weather ").title == "Weather")
        #expect(StoreCategories.shelf(for: nil).title == "Other scenes")
        #expect(StoreCategories.shelf(for: "gardening").title == "Other scenes")
        #expect(StoreCategories.rank(ofTitle: "Photos") < StoreCategories.rank(ofTitle: "Other scenes"))
        #expect(StoreCategories.rank(ofTitle: "Other scenes") < StoreCategories.rank(ofTitle: "My scenes"))
    }
}
