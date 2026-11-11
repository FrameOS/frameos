import SwiftUI

#if os(iOS)
import UIKit
public typealias PlatformImage = UIImage
#else
import AppKit
public typealias PlatformImage = NSImage
#endif

extension Image {
    init(platformImage: PlatformImage) {
        #if os(iOS)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}

/// Put the keyboard away (a search field keeps it up over a sheet it opens).
@MainActor
func hideKeyboard() {
    #if os(iOS)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    #endif
}

/// iOS-only modifiers, so the screens also type-check on macOS (`ios/bin/check-ui`).
extension View {
    func inlineTitle() -> some View {
        #if os(iOS)
        return navigationBarTitleDisplayMode(.inline)
        #else
        return self
        #endif
    }

    func largeTitle() -> some View {
        #if os(iOS)
        return navigationBarTitleDisplayMode(.large)
        #else
        return self
        #endif
    }

    func emailInput() -> some View {
        #if os(iOS)
        return textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        return autocorrectionDisabled()
        #endif
    }

    func passwordInput(new: Bool = false) -> some View {
        #if os(iOS)
        return textContentType(new ? .newPassword : .password)
        #else
        return self
        #endif
    }

    func codeInput() -> some View {
        #if os(iOS)
        return textContentType(.oneTimeCode).keyboardType(.asciiCapable).textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        return autocorrectionDisabled()
        #endif
    }

    func urlInput() -> some View {
        #if os(iOS)
        return keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        return autocorrectionDisabled()
        #endif
    }

    func numberInput(decimal: Bool = true) -> some View {
        #if os(iOS)
        return keyboardType(decimal ? .decimalPad : .numberPad)
        #else
        return self
        #endif
    }

    func plainInput() -> some View {
        #if os(iOS)
        return textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        return autocorrectionDisabled()
        #endif
    }

    func groupedList() -> some View {
        #if os(iOS)
        return listStyle(.insetGrouped)
        #else
        return listStyle(.inset)
        #endif
    }
}

enum Pasteboard {
    static func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

enum Haptics {
    static func success() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    static func failure() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        #endif
    }
}

/// The FrameOS colors (the logo's three squares).
enum Brand {
    static let teal = Color(red: 0.12, green: 0.49, blue: 0.42)
    static let green = Color(red: 0.55, green: 0.67, blue: 0.23)
    static let gold = Color(red: 0.78, green: 0.64, blue: 0.28)
}
