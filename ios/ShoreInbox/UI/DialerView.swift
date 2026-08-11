import SwiftUI
import UIKit

/// Keypad for outbound calls. Inbound calls never appear here — those are
/// handled entirely by the system call screen via CallKit.
struct DialerView: View {
    @EnvironmentObject private var session: SessionModel
    @State private var number = ""

    private let keys: [[String]] = [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
        ["*", "0", "#"]
    ]

    /// Sub-labels under each digit, matching the system dialler — including the
    /// "+" under 0, which is what makes the long-press discoverable.
    private let letters: [String: String] = [
        "2": "ABC", "3": "DEF", "4": "GHI", "5": "JKL",
        "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ",
        "0": "+"
    ]

    /// Set when a long press has already inserted its value, so the tap that
    /// arrives on release does not also insert the digit.
    @State private var longPressInserted = false

    var body: some View {
        VStack(spacing: 0) {
            connectionBanner

            Spacer(minLength: 12)

            Text(number.isEmpty ? " " : PhoneFormatter.pretty(number))
                .font(.system(size: 34, weight: .light, design: .rounded))
                .monospacedDigit()
                .frame(height: 44)
                .animation(.none, value: number)

            Spacer(minLength: 12)

            VStack(spacing: 16) {
                ForEach(keys, id: \.self) { row in
                    HStack(spacing: 28) {
                        ForEach(row, id: \.self) { key in
                            keypadButton(key)
                        }
                    }
                }
            }

            Spacer(minLength: 20)

            HStack(spacing: 40) {
                Color.clear.frame(width: 72, height: 72)

                Button(action: placeCall) {
                    Image(systemName: "phone.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(.white)
                        .frame(width: 72, height: 72)
                        .background(Circle().fill(canCall ? ShoreTheme.seaGreen : ShoreTheme.seaGreen.opacity(0.4)))
                }
                .disabled(!canCall)

                Button {
                    if !number.isEmpty { number.removeLast() }
                } label: {
                    Image(systemName: "delete.left")
                        .font(.system(size: 24))
                        .foregroundStyle(number.isEmpty ? .clear : .primary)
                        .frame(width: 72, height: 72)
                }
                .disabled(number.isEmpty)
            }

            Spacer(minLength: 16)
        }
        .padding(.horizontal)
    }

    private var canCall: Bool {
        number.filter(\.isNumber).count >= 7 && session.isVoiceReady
    }

    @ViewBuilder
    private var connectionBanner: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(session.isVoiceReady ? ShoreTheme.seaGreen : ShoreTheme.rescueOrange)
                .frame(width: 8, height: 8)
            Text(session.voiceStatusText)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            if !session.callerNumber.isEmpty {
                Text(PhoneFormatter.pretty(session.callerNumber))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
    }

    private func keypadButton(_ key: String) -> some View {
        // 0 is the only key with a long-press action, which mirrors the system
        // dialler: the letters under the other digits are labels for reading a
        // number aloud, not alternative input. Holding 4 does not type "G" on
        // an iPhone either.
        let longPressValue: String? = (key == "0") ? "+" : nil

        // Not a Button: a Button's own tap handling competes with the long
        // press and fires both on release.
        return VStack(spacing: 2) {
            Text(key).font(.system(size: 32, weight: .regular))
            if let sub = letters[key] {
                Text(sub)
                    .font(.system(size: key == "0" ? 15 : 10, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 72, height: 72)
        .background(Circle().fill(Color.secondary.opacity(0.12)))
        .foregroundStyle(.primary)
        .contentShape(Circle())
        .onLongPressGesture(minimumDuration: 0.35) {
            guard let value = longPressValue else { return }
            longPressInserted = true
            number.append(value)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        } onPressingChanged: { isPressing in
            if isPressing { longPressInserted = false }
        }
        .onTapGesture {
            // Swallow the release that follows a long press we already handled.
            guard !longPressInserted else { longPressInserted = false; return }
            number.append(key)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        .accessibilityElement()
        .accessibilityLabel(key == "0" ? "0, hold for plus" : key)
        .accessibilityAddTraits(.isButton)
    }

    private func placeCall() {
        session.startOutgoingCall(to: PhoneFormatter.e164(number))
        number = ""
    }
}
