import Foundation
import UIKit

@MainActor
final class InboxModel: ObservableObject {
    @Published private(set) var conversations: [ConversationSummary] = []
    @Published private(set) var messages: [String: [MessageRecord]] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published var errorMessage: String?
    private var refreshInProgress = false
    private var threadRefreshes: Set<String> = []

    var unreadTotal: Int {
        conversations.reduce(0) { total, conversation in
            total + max(0, conversation.unreadCount ?? 0)
        }
    }

    func load() async {
        guard !refreshInProgress else { return }
        refreshInProgress = true
        isLoading = conversations.isEmpty
        defer { isLoading = false; refreshInProgress = false }
        do {
            let loaded = try await APIClient.shared.fetchConversations()
            if loaded != conversations { conversations = loaded }
            await MessageNotificationManager.shared.setUnreadMessages(unreadTotal)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadThread(phone: String) async {
        guard !threadRefreshes.contains(phone) else { return }
        threadRefreshes.insert(phone)
        defer { threadRefreshes.remove(phone) }
        do {
            let loaded = try await APIClient.shared.fetchThread(phone: phone)
            if messages[phone] != loaded { messages[phone] = loaded }
            if let index = conversations.firstIndex(where: { $0.phone == phone }),
               (conversations[index].unreadCount ?? 0) > 0 {
                await load()
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func send(text: String, imageData: [Data], to phone: String,
              replyingTo message: MessageRecord?) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !imageData.isEmpty else { return false }
        isSending = true
        defer { isSending = false }
        do {
            var urls: [String] = []
            let selectedImages = Array(imageData.prefix(4))
            // Telnyx allows each file below 1 MB and the combined payload below
            // 2 MB, but recommends staying below 600 KB for delivery across
            // every US carrier/sender type. Divide
            // that safe envelope across the selected attachments rather than
            // independently producing several near-1 MB files.
            let perImageBudget = 580_000 / max(1, selectedImages.count)
            for original in selectedImages {
                guard let image = UIImage(data: original),
                      let compressed = Self.carrierSafeJPEG(image, maximumBytes: perImageBudget) else {
                    throw APIError.server("One of the selected images could not be prepared.")
                }
                urls.append(try await APIClient.shared.uploadJPEG(compressed))
            }
            try await APIClient.shared.sendMessage(
                to: phone,
                message: trimmed,
                mediaURLs: urls,
                replyToMessageID: message?.numericID
            )
            await loadThread(phone: phone)
            await load()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func react(to message: MessageRecord, type: String, phone: String) async {
        guard let id = message.numericID else { return }
        do {
            try await APIClient.shared.react(to: id, type: type)
            await loadThread(phone: phone)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Produces an upload that is guaranteed to fit the backend's 1 MB hard
    /// limit. Merely lowering JPEG quality is not enough for large/noisy camera
    /// photos: the old implementation could still return more than 1 MB and
    /// every such selection failed later at `/api/upload` with HTTP 413.
    static func carrierSafeJPEG(_ image: UIImage, maximumBytes: Int = 850_000) -> Data? {
        guard image.size.width > 0, image.size.height > 0, maximumBytes > 0 else { return nil }

        for maximumDimension: CGFloat in [1600, 1280, 1024, 800, 640, 480, 320] {
            let scale = min(1, maximumDimension / max(image.size.width, image.size.height))
            let size = CGSize(width: max(1, image.size.width * scale),
                              height: max(1, image.size.height * scale))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let renderer = UIGraphicsImageRenderer(size: size, format: format)
            let resized = renderer.image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                image.draw(in: CGRect(origin: .zero, size: size))
            }

            for quality: CGFloat in [0.82, 0.72, 0.62, 0.52, 0.42, 0.32, 0.24] {
                if let data = resized.jpegData(compressionQuality: quality),
                   data.count <= maximumBytes {
                    return data
                }
            }
        }
        return nil
    }
}

@MainActor
final class ContactsModel: ObservableObject {
    @Published private(set) var contacts: [ConversationSummary] = []
    @Published private(set) var detail: ContactDetailResponse?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    func load(search: String = "") async {
        isLoading = contacts.isEmpty
        defer { isLoading = false }
        do {
            contacts = try await APIClient.shared.fetchAllContacts(search: search)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func loadDetail(phone: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await APIClient.shared.fetchContact(phone: phone)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func create(firstName: String, lastName: String, phone: String,
                email: String, notes: String) async -> Bool {
        do {
            _ = try await APIClient.shared.createContact(firstName: firstName, lastName: lastName,
                                                         phone: phone, email: email, notes: notes)
            await load()
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }

    func update(_ contact: ConversationSummary, firstName: String, lastName: String,
                email: String, notes: String) async -> Bool {
        do {
            _ = try await APIClient.shared.updateContact(phone: contact.phone, firstName: firstName,
                                                         lastName: lastName, email: email, notes: notes)
            await loadDetail(phone: contact.phone)
            await load()
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }
}

@MainActor
final class CallHistoryModel: ObservableObject {
    @Published private(set) var logs: [CallLogRecord] = []
    @Published private(set) var isLoading = false
    /// Drives the red count on the Calls tab.
    @Published private(set) var unseenMissed = 0
    @Published var errorMessage: String?

    /// Missed calls this device has already shown in history.
    ///
    /// The server tracks the same thing in `call_logs.seen_at`, which is what
    /// keeps the Home Screen badge correct on a message push. This local copy
    /// exists so the badge still clears on a database that has not had
    /// scripts/missed-calls-seen-migration.sql applied, and when the request to
    /// mark them fails. Ids are used rather than a timestamp so there is no
    /// dependence on the device clock agreeing with the server's.
    // "shore." prefix: fresh app with no installed users, so renaming the
    // UserDefaults keys from the previous brand is safe.
    private let seenIDsKey = "shore.calls.seen-missed-ids"
    /// History returns 50 rows a page, so this cannot drop an id still on screen.
    private let seenIDLimit = 300
    private let didSeedKey = "shore.calls.seeded-existing-history"

    private var seenIDs: [String] {
        get { UserDefaults.standard.stringArray(forKey: seenIDsKey) ?? [] }
        set { UserDefaults.standard.set(newValue.suffix(seenIDLimit).map { $0 }, forKey: seenIDsKey) }
    }

    func load() async {
        isLoading = logs.isEmpty
        defer { isLoading = false }
        do { logs = try await APIClient.shared.fetchCallLogs(); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
        seedExistingHistoryIfNeeded()
        await recount()
    }

    /// Calls that happened before this device ever ran the feature are history,
    /// not a backlog of notifications. Without this the badge would open on a
    /// count of every missed call ever recorded. Mirrors the same one-off
    /// backfill in scripts/missed-calls-seen-migration.sql.
    private func seedExistingHistoryIfNeeded() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: didSeedKey) else { return }
        // Only seed once the first response has actually arrived, or a failed
        // load would mark the flag with nothing recorded and let old calls
        // through on the next attempt.
        guard !logs.isEmpty else { return }
        seenIDs = seenIDs + logs.filter(\.isMissedInbound).map(\.id)
        defaults.set(true, forKey: didSeedKey)
    }

    private func recount() async {
        let seen = Set(seenIDs)
        unseenMissed = logs.filter { $0.isMissedInbound && $0.seenAt == nil && !seen.contains($0.id) }.count
        await MessageNotificationManager.shared.setMissedCalls(unseenMissed)
    }

    /// Called when call history is actually on screen. Looking at the list is
    /// what clears the count, the same way WhatsApp behaves — the operator does
    /// not have to open each call.
    func markHistorySeen() async {
        var seen = seenIDs
        let known = Set(seen)
        let newlySeen = logs.filter(\.isMissedInbound).map(\.id).filter { !known.contains($0) }
        if !newlySeen.isEmpty {
            seen.append(contentsOf: newlySeen)
            seenIDs = seen
        }

        // Cleared unconditionally. A call missed while the app was in the
        // background moves the Home Screen badge before its log row is written,
        // so the count can be non-zero with nothing new in the list yet.
        unseenMissed = 0
        await MessageNotificationManager.shared.setMissedCalls(0)
        // Best effort: this keeps the badge attached to message pushes correct
        // and clears the count on the other signed-in device. A failure only
        // means the server copy lags; this device has already recorded it.
        await APIClient.shared.markMissedCallsSeen()
    }
}
