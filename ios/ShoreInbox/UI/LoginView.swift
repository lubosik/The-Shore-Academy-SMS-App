import SwiftUI

/// One-time login using the same shared inbox password the web app uses.
/// After this the password lives in the Keychain so a push-woken cold launch
/// can re-authenticate without any user interaction.
///
/// The backdrop is a layered, continuously animating ocean wave — the client
/// asked for "a nice animated wave when you're logging in". It sits behind the
/// form, ignores touches, and freezes completely when Reduce Motion is on.
struct LoginView: View {
    @EnvironmentObject private var session: SessionModel
    @State private var password = ""
    @State private var isWorking = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            ShoreTheme.waveBackdrop
                .ignoresSafeArea()

            OceanWaves()

            VStack(spacing: 24) {
                Spacer()

                VStack(spacing: 8) {
                    Image(systemName: "water.waves")
                        .font(.system(size: 52, weight: .medium))
                        .foregroundStyle(ShoreTheme.tint)
                    Text("The Shore Academy")
                        .font(.system(.largeTitle, design: .rounded).bold())
                        .foregroundStyle(ShoreTheme.tint)
                    Text("Confidence in the Water. For Life.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 12) {
                    SecureField("Inbox password", text: $password)
                        .textContentType(.password)
                        .textFieldStyle(.roundedBorder)
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit(submit)

                    if let error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(ShoreTheme.rescueOrange)
                            .multilineTextAlignment(.center)
                    }

                    Button(action: submit) {
                        if isWorking {
                            ProgressView().tint(.white).frame(maxWidth: .infinity)
                        } else {
                            Text("Sign in").bold().frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(ShoreTheme.navyFill)
                    .controlSize(.large)
                    .disabled(password.isEmpty || isWorking)
                }
                .padding(.horizontal, 32)

                Spacer()
                Spacer()
            }
        }
        .onAppear { focused = true }
    }

    private func submit() {
        guard !password.isEmpty, !isWorking else { return }
        isWorking = true
        error = nil
        Task { @MainActor in
            do {
                try await session.signIn(password: password)
            } catch {
                self.error = error.localizedDescription
            }
            isWorking = false
        }
    }
}

// MARK: - Animated ocean wave backdrop

/// Layered sine waves in ocean blues, drawn into a single Canvas that a
/// TimelineView redraws each frame. One view, one draw pass — no Timers and no
/// per-layer animated views. Purely decorative: it never intercepts touches.
private struct OceanWaves: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                // Hard requirement: with Reduce Motion on, render a still wave
                // with no animation clock at all.
                WaveCanvas(time: 0)
            } else {
                TimelineView(.animation) { context in
                    WaveCanvas(time: context.date.timeIntervalSinceReferenceDate)
                }
            }
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }
}

private struct WaveCanvas: View {
    let time: TimeInterval

    /// One band of water. Depth is faked by stacking translucent layers:
    /// slower, paler swells at the back; faster, deeper blue water in front.
    private struct Layer {
        let baseline: CGFloat    // waterline as a fraction of view height
        let amplitude: CGFloat   // points
        let wavelength: CGFloat  // points
        let speed: Double        // radians per second
        let phase: Double        // radians, de-synchronises the layers
        let color: Color
        let opacity: Double
    }

    private static let layers: [Layer] = [
        Layer(baseline: 0.78, amplitude: 16, wavelength: 460, speed: 0.30, phase: 0.0,
              color: ShoreTheme.waveShallow, opacity: 0.30),
        Layer(baseline: 0.82, amplitude: 13, wavelength: 340, speed: 0.48, phase: 1.9,
              color: ShoreTheme.waveMid, opacity: 0.40),
        Layer(baseline: 0.86, amplitude: 10, wavelength: 260, speed: 0.72, phase: 3.7,
              color: ShoreTheme.waveDeep, opacity: 0.50),
        Layer(baseline: 0.90, amplitude: 7, wavelength: 210, speed: 1.00, phase: 5.2,
              color: ShoreTheme.waveDeep, opacity: 0.80)
    ]

    var body: some View {
        Canvas { context, size in
            for layer in Self.layers {
                context.fill(wavePath(for: layer, in: size),
                             with: .color(layer.color.opacity(layer.opacity)))
            }
        }
    }

    private func wavePath(for layer: Layer, in size: CGSize) -> Path {
        var path = Path()
        let base = layer.baseline * size.height
        let step: CGFloat = 6   // sample every 6pt — smooth, and cheap to fill

        func surfaceY(at x: CGFloat) -> CGFloat {
            let progress = (2 * .pi) * Double(x) / Double(layer.wavelength)
            // Two sines per layer: the second, shorter and quicker, breaks the
            // perfect regularity so the water feels organic rather than plotted.
            let primary = sin(progress + time * layer.speed + layer.phase)
            let ripple = 0.35 * sin(progress * 1.9 + time * layer.speed * 1.5 + layer.phase * 2)
            return base + layer.amplitude * CGFloat(primary + ripple)
        }

        path.move(to: CGPoint(x: 0, y: surfaceY(at: 0)))
        var x = step
        while x < size.width {
            path.addLine(to: CGPoint(x: x, y: surfaceY(at: x)))
            x += step
        }
        path.addLine(to: CGPoint(x: size.width, y: surfaceY(at: size.width)))
        path.addLine(to: CGPoint(x: size.width, y: size.height))
        path.addLine(to: CGPoint(x: 0, y: size.height))
        path.closeSubpath()
        return path
    }
}
