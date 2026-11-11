import XCTest

/// What the UI tests share: launching the app clean, screenshots kept in the
/// result bundle (`ios/bin/ui-test` copies them out), waiting for words.
extension XCTestCase {
    /// The app with no account: `-FrameOSUITesting` makes it start signed
    /// out and keep nothing (see FrameOSApp.swift).
    @MainActor
    func launchClean(_ environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-FrameOSUITesting"]
        app.launchEnvironment.merge(environment) { _, new in new }
        app.launch()
        return app
    }

    /// A screenshot kept in the result bundle under `name`, with the screen's
    /// accessibility tree beside it (what a failing query should have found).
    @MainActor
    func snapshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "\(name).tree"
        tree.lifetime = .keepAlways
        add(tree)
    }

    /// Wait until some element shows these words (a label or a value).
    @MainActor
    @discardableResult
    func waitForText(_ app: XCUIApplication, _ text: String, timeout: TimeInterval = 20,
                     file: StaticString = #filePath, line: UInt = #line) -> XCUIElement
    {
        let element = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
        if !element.waitForExistence(timeout: timeout) {
            snapshot(app, "missing \(text)")
            XCTFail("\"\(text)\" did not show in \(Int(timeout)) s", file: file, line: line)
        }
        return element
    }

    /// The first button whose label holds these words.
    @MainActor
    func button(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// A tab: a tab bar at the bottom of an iPhone, a bar at the top of an
    /// iPad (not a TabBar there). Both are buttons named by the tab's symbol.
    @MainActor
    func tab(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        let symbols = ["Frames": "photo.on.rectangle", "Scenes": "square.grid.2x2", "Photos": "photo.stack",
                       "AI": "sparkles", "Settings": "gearshape"]
        return app.buttons.matching(NSPredicate(format: "label == %@ AND identifier == %@", name, symbols[name] ?? name)).firstMatch
    }

    @MainActor
    func type(_ field: XCUIElement, _ text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no field \(field)")
        field.tap()
        field.typeText(text)
    }
}
