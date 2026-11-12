import SwiftUI

// How the screens use an iPad's width. A phone's screen is one column of
// rows and pictures at its width; an iPad's is three times as wide, and the
// same layout there drew a portrait panel's picture taller than the screen,
// stretched a label and its value 1,300 points apart, and left a row of
// cards with holes where one card was taller.

enum ReadableWidth {
    /// Lists and forms: about UIKit's readable width at the default text size.
    static let form: CGFloat = 720
    /// The sign-in screen: a few fields and buttons.
    static let signIn: CGFloat = 540
    /// The AI chat's messages and its field.
    static let chat: CGFloat = 760
    /// From this width a screen has room for columns or a grid: an iPad (not
    /// its form sheets, about 580), the iPhone Duo's inner screen (669), a
    /// phone on its side. Never a phone held upright (440 at most).
    static let wide: CGFloat = 600
}

extension View {
    /// The rows of a list or form at most `maxWidth` wide, in the middle of
    /// the screen; the background still fills it. Nothing changes on a phone.
    func readableWidth(_ maxWidth: CGFloat = ReadableWidth.form) -> some View {
        modifier(ReadableWidthModifier(maxWidth: maxWidth))
    }

    /// Keeps `width` at this view's width.
    func measureWidth(_ width: Binding<CGFloat>) -> some View {
        onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width.wrappedValue = $0 }
    }

    /// Keeps `size` at this view's size.
    func measureSize(_ size: Binding<CGSize>) -> some View {
        onGeometryChange(for: CGSize.self) { $0.size } action: { size.wrappedValue = $0 }
    }
}

private struct ReadableWidthModifier: ViewModifier {
    let maxWidth: CGFloat
    @State private var width: CGFloat = 0

    func body(content: Content) -> some View {
        content
            // Safe area, not content margins: added to the list's own insets
            // (zero on a phone leaves them as they are).
            .safeAreaPadding(.horizontal, max(0, (width - maxWidth) / 2))
            .measureWidth($width)
    }
}

/// One picture of a known shape (`aspect`, width over height) in a box: the
/// box takes the width it is offered and `boxAspect`'s shape (the picture's
/// own without one), never taller than `maxHeight`, and the picture is
/// fitted inside it, in the middle. A grid gives every card one box shape so
/// a row of cards is one height; a page caps the height so a portrait panel
/// is not taller than the screen.
struct FittedBox: Layout {
    var aspect: Double
    var boxAspect: Double?
    var maxHeight: CGFloat = .infinity

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let shape = CGFloat(max(boxAspect ?? aspect, 0.05))
        let width: CGFloat
        if let offered = proposal.width, offered.isFinite {
            width = offered
        } else if let offered = proposal.height, offered.isFinite {
            width = min(offered, maxHeight) * shape
        } else {
            width = min(320, maxHeight * shape)
        }
        let height = min(width / shape, maxHeight, proposal.height ?? .infinity)
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let shape = CGFloat(max(aspect, 0.05))
        let width = min(bounds.width, bounds.height * shape)
        let size = ProposedViewSize(width: width, height: width / shape)
        for subview in subviews {
            subview.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center, proposal: size)
        }
    }
}

extension Color {
    /// The grouped list's background, for a screen that sets a list beside
    /// other content.
    static var groupedBackground: Color {
        #if os(iOS)
        Color(uiColor: .systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }

    /// A grouped list's row background.
    static var groupedCell: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemGroupedBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }
}

extension View {
    /// Covers the whole screen on iOS (a photo); a sheet on macOS, where the
    /// screens are only type-checked.
    func fullScreenSheet<Item: Identifiable, Content: View>(item: Binding<Item?>,
                                                            @ViewBuilder content: @escaping (Item) -> Content) -> some View {
        #if os(iOS)
        return fullScreenCover(item: item, content: content)
        #else
        return sheet(item: item, content: content)
        #endif
    }

    /// A larger sheet where the system has one (iOS 18: the "page" size on an
    /// iPad, room for the store's grid). A phone's sheet is the same either way.
    @ViewBuilder func pageSizedSheet() -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            presentationSizing(.page)
        } else {
            self
        }
    }
}
