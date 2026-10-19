import Foundation

@main
struct SMSSegmenterSmoke {
    static func main() throws {
        let text = "🧭 On the sand\n• Sun safety — hydration\n🌊 In the shallows\n• Watch the current\n🏄 In the water\n• Flip, float, follow\n" + String(repeating: " Be safe in the ocean.", count: 43)
        precondition(SMSSegmenter.segmentCount(text) > 10)
        let safe = try SMSSegmenter.prepared(text, hasMedia: false)
        precondition(SMSSegmenter.segmentCount(safe) <= 10)
        precondition(safe.contains("Sun safety - hydration"))
        precondition(safe.contains("Flip, float, follow"))
        print("SMS conversion smoke test passed")
    }
}
