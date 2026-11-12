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

    /// A button of the navigation bar's ("More", "Add"). The iPhone Duo's
    /// cover screen draws them in a rail beside the content, outside the bar.
    @MainActor
    func barButton(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        let inBar = app.navigationBars.buttons[name]
        return inBar.exists ? inBar : app.buttons[name].firstMatch
    }

    /// Whether an element is on screen to tap. isHittable alone says yes for
    /// a row scrolled up under the iPhone Duo's cover screen's bar, whose
    /// tap then lands above the screen.
    @MainActor
    func onScreen(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        guard element.exists, element.isHittable else { return false }
        let screen = app.windows.firstMatch.frame
        let middle = element.frame.midY
        return middle > screen.minY + 90 && middle < screen.maxY - 40
    }

    /// A short scroll with no fling (a third of the screen), so a row near
    /// an edge comes on screen; a swipe flings past it on a short screen.
    /// `up` moves the content up, as swipeUp does. Left of the middle: the
    /// iPhone Duo's cover screen has its bar buttons down the right edge.
    @MainActor
    func nudge(_ app: XCUIApplication, up: Bool) {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: up ? 0.7 : 0.35))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: up ? 0.35 : 0.7))
        from.press(forDuration: 0.1, thenDragTo: to)
    }

    /// The screen's search field. Where it is folded into a Search button
    /// (the iPhone Duo's cover screen), the button opens it first.
    @MainActor
    func searchField(_ app: XCUIApplication) -> XCUIElement {
        let field = app.searchFields.firstMatch
        if !field.waitForExistence(timeout: 5) {
            let open = app.buttons["Search"].firstMatch
            if open.exists { open.tap() }
        }
        return field
    }

    /// Done on a sheet that was scrolled. The iPhone Duo's cover screen
    /// scrolls a sheet's bar away with its content: back up first (a swipe
    /// at the top closes the sheet, which is what Done does).
    @MainActor
    func tapDone(_ app: XCUIApplication) {
        let done = app.buttons["Done"].firstMatch
        var tries = 0
        while !done.exists && tries < 3 {
            app.swipeDown()
            tries += 1
        }
        if done.exists { done.tap() }
    }

    /// Back to the screen before: the bar's first button, or the Duo's
    /// rail's.
    @MainActor
    func goBack(_ app: XCUIApplication) {
        let inBar = app.navigationBars.buttons.element(boundBy: 0)
        if inBar.exists {
            inBar.tap()
        } else {
            app.buttons["BackButton"].firstMatch.tap()
        }
    }

    @MainActor
    func type(_ field: XCUIElement, _ text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no field \(field)")
        field.tap()
        field.typeText(text)
    }
}
