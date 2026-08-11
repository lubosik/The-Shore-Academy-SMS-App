import Foundation

/// Static configuration for the app. The server URL points at the same
/// Railway backend the web inbox uses — the iOS app is a second client
/// onto the existing system, not a separate stack.
enum AppConfig {

    /// Base URL of the Shore Academy inbox backend (Railway).
    /// Override at runtime with the `SHORE_SERVER_URL` env var when debugging.
    ///
    /// Verified against the running deployment, not guessed — a wrong value here
    /// produces a silent login failure ("Wrong password, or the session
    /// expired") that is very hard to diagnose in the field. If Railway ever
    /// regenerates the domain, this must be updated and the app rebuilt.
    static let serverURL: URL = {
        if let raw = ProcessInfo.processInfo.environment["SHORE_SERVER_URL"],
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "https://web-production-6fd6a.up.railway.app")!
    }()

    /// Telnyx push environment must match how the binary was signed:
    /// debug builds get a sandbox APNs token, TestFlight/App Store get production.
    /// Getting this wrong is the single most common cause of "push never arrives".
    static var pushEnvironmentIsProduction: Bool {
        #if DEBUG
        return false
        #else
        return true
        #endif
    }

    /// A connected SDK client receives the INVITE directly and reports it to
    /// CallKit. Asking Telnyx to also push while that socket is active makes
    /// SDK 4.1.2 disconnect the live socket in `processVoIPNotification`, which
    /// can discard the INVITE while the user is answering.
    static let pushWhenActive = false

    /// Shown as the app name in the native iOS call UI (lock screen, Recents).
    static let callKitDisplayName = "Shore Academy"
}
