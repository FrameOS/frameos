import Foundation

/// The FrameOS Cloud store's shelves, in shelf order: the SPA's
/// `frontend/src/utils/storeCategories.ts` (itself checked against the
/// cloud's `src/lib/categories.ts`). `StoreCategoryTests` reads the SPA's
/// file, so this copy cannot drift from it.
public enum StoreCategories {
    public static let shelves: [(slug: String, title: String)] = [
        ("photos", "Photos"),
        ("art", "Art & galleries"),
        ("calendar", "Calendars & agendas"),
        ("weather", "Weather"),
        ("ai", "AI & generative"),
        ("dashboards", "Data & dashboards"),
        ("fun", "Fun & comics"),
        ("realtime", "Real time"),
        ("layouts", "Layouts"),
        ("utilities", "Tools & utilities"),
        ("demos", "Demos & examples"),
    ]

    /// Scenes without a (known) category land here, after the others.
    public static let other = (slug: "other", title: "Other scenes")

    /// The shelf a scene belongs on (the SPA's storeShelfForCategory).
    public static func shelf(for category: String?) -> (slug: String, title: String) {
        let slug = (category ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return shelves.first { $0.slug == slug } ?? other
    }

    /// Where a shelf title sorts: its place in the list, "Other scenes" after
    /// them, anything else (a backend repository, "My scenes") after that.
    public static func rank(ofTitle title: String) -> Int {
        if let index = shelves.firstIndex(where: { $0.title == title }) { return index }
        return title == other.title ? shelves.count : shelves.count + 1
    }
}
