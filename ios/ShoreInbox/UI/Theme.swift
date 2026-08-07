import SwiftUI
import UIKit

/// The Shore Academy brand palette — the single source of truth for colour in
/// this app. Do not scatter hex literals through views; add a semantic token
/// here instead.
///
/// Brand kit:
///   Navy   #123A5A  — primary ("their ocean blue")
///   Cream  #E6D6B8  — secondary
///   Orange #E85A2E  — accent (rescue-equipment orange: urgent/destructive,
///                     unread badges — used sparingly)
///
/// Every token is a dynamic colour: brand navy reads well on white but not on
/// black, so dark mode substitutes lifted variants of the same hue rather than
/// repainting surfaces. System semantic colours remain the base for large
/// surfaces; brand colour is applied as accent.
enum ShoreTheme {

    // MARK: - Core brand tokens

    /// Interactive tint: tab bar, links, buttons, icons. Brand navy in light
    /// mode; a lighter ocean blue in dark mode so tinted text stays legible.
    static let tint = dynamic(light: 0x123A5A, dark: 0x7FAFD4)

    /// Filled navy surface (outbound message bubbles, primary filled buttons).
    /// Slightly lifted in dark mode so the fill separates from a black
    /// background; white foreground text works on both variants.
    static let navyFill = dynamic(light: 0x123A5A, dark: 0x1E5075)

    /// Rescue orange — urgent/destructive actions, unread badges, missed calls.
    /// White text passes contrast on both variants.
    static let rescueOrange = dynamic(light: 0xE85A2E, dark: 0xF0703F)

    /// UIKit twin of `rescueOrange`, for appearance proxies SwiftUI cannot
    /// reach (the tab-bar badge background).
    static let rescueOrangeUI = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(hex: 0xF0703F) : UIColor(hex: 0xE85A2E)
    }

    /// Cream-derived subtle surface (avatar circles, soft chips). Cream itself
    /// would glow on a dark background, so dark mode uses a navy-tinted fill.
    static let sandFill = dynamic(light: 0xE6D6B8, dark: 0x243B4E)

    /// Foreground drawn on top of `sandFill` (avatar initials).
    static let onSand = dynamic(light: 0x123A5A, dark: 0xD8E4EE)

    /// Positive/ready states (call button, connection dot, delivered calls).
    /// A sea green rather than system green so it sits in the ocean palette.
    static let seaGreen = dynamic(light: 0x1F7A5C, dark: 0x35A57F)

    // MARK: - Gradients

    /// In-call backdrop: a quiet vertical ocean fade behind the system-styled
    /// controls. Uses opacity so it adapts to light/dark automatically.
    static let callBackdrop = LinearGradient(
        colors: [Color(hex: 0x123A5A).opacity(0.14), .clear],
        startPoint: .top, endPoint: .bottom
    )

    // MARK: - Wave palette (login screen)

    /// Fixed ocean blues for the animated wave. These are drawn over
    /// `waveBackdrop`, layered with opacity to fake depth, and work unchanged
    /// in both appearances.
    static let waveDeep    = Color(hex: 0x123A5A)
    static let waveMid     = Color(hex: 0x2E6288)
    static let waveShallow = Color(hex: 0x5E93B8)

    /// Sky behind the login wave: airy white-blue by day, deep-ocean night in
    /// dark mode.
    static let waveBackdrop = dynamic(light: 0xF4F8FB, dark: 0x0A1D2E)

    // MARK: - Plumbing

    /// Trait-aware colour from two sRGB hex values.
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        })
    }
}

extension Color {
    /// Fixed (non-adaptive) colour from an sRGB hex value like 0x123A5A.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
