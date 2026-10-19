import Foundation

/// Keeps a long text inside Telnyx's ten-part SMS limit before GHL queues it.
/// A single emoji or curly dash switches the entire SMS to UCS-2, where each
/// multipart segment holds only 67 UTF-16 units instead of 153 GSM-7 septets.
enum SMSSegmenter {
    private static let maxSegments = 10
    private static let gsmBasic = Set<Character>(
        "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
    )
    private static let gsmExtended = Set<Character>("^{}\\[~]|€")

    static func segmentCount(_ text: String) -> Int {
        var septets = 0
        for character in text {
            if gsmBasic.contains(character) { septets += 1 }
            else if gsmExtended.contains(character) { septets += 2 }
            else {
                let units = text.utf16.count
                return units <= 70 ? 1 : (units + 66) / 67
            }
        }
        return septets <= 160 ? 1 : (septets + 152) / 153
    }

    static func prepared(_ text: String, hasMedia: Bool) throws -> String {
        let count = segmentCount(text)
        guard !hasMedia, count > maxSegments else { return text }

        var safe = text
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .replacingOccurrences(of: "[‘’]", with: "'", options: .regularExpression)
            .replacingOccurrences(of: "[“”]", with: "\"", options: .regularExpression)
            .replacingOccurrences(of: "[—–−]", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "•", with: "-")
            .replacingOccurrences(of: "…", with: "...")
        // Emoji in headings are decorative; remove them only when the message
        // would otherwise be rejected, leaving the lesson wording intact.
        safe = safe.replacingOccurrences(
            of: "\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic})*",
            with: "",
            options: .regularExpression
        )
        safe = safe
            .replacingOccurrences(of: " {3,}", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "[ \\t]+\\n", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !safe.isEmpty, segmentCount(safe) <= maxSegments else {
            throw SMSLengthError(segments: count)
        }
        return safe
    }
}

struct SMSLengthError: LocalizedError {
    let segments: Int

    var errorDescription: String? {
        "This text needs \(segments) SMS parts; the limit is 10. Shorten it or attach an image to send it as MMS."
    }
}
