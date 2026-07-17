import AppKit
import SwiftUI

enum HostPalette {
    static let ink = Color(red: 0.105, green: 0.105, blue: 0.14)
    static let secondaryInk = Color(red: 0.25, green: 0.25, blue: 0.32)
    static let lavender = Color(red: 0.49, green: 0.43, blue: 0.76)
    static let lavenderDeep = Color(red: 0.36, green: 0.29, blue: 0.66)
    static let mint = Color(red: 0.28, green: 0.68, blue: 0.55)
    static let amber = Color(red: 0.88, green: 0.58, blue: 0.25)
    static let rose = Color(red: 0.80, green: 0.39, blue: 0.48)
}

struct BorrowedLightWeather: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.70, green: 0.80, blue: 0.96),
                    Color(red: 0.85, green: 0.79, blue: 0.96),
                    Color(red: 0.98, green: 0.83, blue: 0.75),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [Color.white.opacity(0.92), Color.white.opacity(0)],
                center: UnitPoint(x: 0.66, y: 0.18),
                startRadius: 12,
                endRadius: 390
            )
            RadialGradient(
                colors: [HostPalette.lavender.opacity(0.26), Color.clear],
                center: UnitPoint(x: 0.12, y: 0.86),
                startRadius: 20,
                endRadius: 420
            )
        }
        .ignoresSafeArea()
    }
}

struct FoundationGlass<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .background {
                RoundedRectangle(cornerRadius: 42, style: .continuous)
                    .fill(Color.white.opacity(0.22))
                    .glassEffect(
                        .regular.tint(Color.white.opacity(0.12)),
                        in: RoundedRectangle(cornerRadius: 42, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 42, style: .continuous)
                            .stroke(Color.white.opacity(0.52), lineWidth: 0.8)
                    }
                    .shadow(color: HostPalette.lavenderDeep.opacity(0.18), radius: 34, y: 18)
            }
    }
}

struct FloatingGlassButtonStyle: ButtonStyle {
    var tint = Color.white.opacity(0.18)

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold, design: .rounded))
            .foregroundStyle(HostPalette.ink)
            .padding(.horizontal, 17)
            .frame(minHeight: 42)
            .background {
                Capsule()
                    .fill(Color.white.opacity(configuration.isPressed ? 0.25 : 0.14))
                    .glassEffect(.regular.tint(tint).interactive(), in: Capsule())
                    .overlay(Capsule().stroke(Color.white.opacity(0.58), lineWidth: 0.7))
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

struct StatusGlyph: View {
    enum State {
        case ready
        case waiting
        case unavailable
    }

    let state: State

    private var color: Color {
        switch state {
        case .ready: HostPalette.mint
        case .waiting: HostPalette.amber
        case .unavailable: HostPalette.rose
        }
    }

    var body: some View {
        Circle()
            .fill(color.opacity(0.16))
            .frame(width: 30, height: 30)
            .overlay {
                Image(systemName: state == .ready ? "checkmark" : state == .waiting ? "ellipsis" : "minus")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(color)
            }
    }
}

struct MetricView: View {
    let eyebrow: String
    let value: String
    let state: StatusGlyph.State?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                if let state {
                    Circle()
                        .fill(state == .ready ? HostPalette.mint : HostPalette.amber)
                        .frame(width: 7, height: 7)
                }
                Text(eyebrow)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
            }
            Text(value)
                .font(.system(size: 22, weight: .medium, design: .rounded))
                .foregroundStyle(HostPalette.ink)
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct WindowChromeConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { configure(view.window) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { configure(nsView.window) }
    }

    private func configure(_ window: NSWindow?) {
        window?.isOpaque = false
        window?.backgroundColor = .clear
        window?.titlebarAppearsTransparent = true
        window?.titleVisibility = .hidden
        window?.isMovableByWindowBackground = true
    }
}
