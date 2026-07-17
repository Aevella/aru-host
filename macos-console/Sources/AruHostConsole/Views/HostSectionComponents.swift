import SwiftUI

struct HostSectionHeader: View {
    let title: String
    let subtitle: String
    let isLoading: Bool
    let refresh: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: 28, weight: .light, design: .rounded))
                    .tracking(-0.25)
                    .foregroundStyle(HostPalette.ink)
                Text(subtitle)
                    .font(.system(size: 12, weight: .regular, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
            }
            Spacer()
            Button(action: refresh) {
                Image(systemName: "arrow.trianglehead.2.clockwise.rotate.90")
                    .rotationEffect(.degrees(isLoading ? 360 : 0))
                    .animation(
                        isLoading ? .linear(duration: 0.85).repeatForever(autoreverses: false) : .default,
                        value: isLoading
                    )
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(FloatingGlassButtonStyle())
            .disabled(isLoading)
            .help(L10n.refresh)
        }
    }
}

struct ReadablePanel<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(20)
            .background {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(Color.white.opacity(0.23))
                    .overlay {
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .stroke(Color.white.opacity(0.44), lineWidth: 0.65)
                    }
            }
    }
}

struct EmptySectionState: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        ReadablePanel {
            HStack(spacing: 18) {
                Image(systemName: symbol)
                    .font(.system(size: 29, weight: .light))
                    .foregroundStyle(HostPalette.lavenderDeep)
                    .frame(width: 42)
                VStack(alignment: .leading, spacing: 5) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(detail)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
        }
    }
}

struct SectionErrorBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.system(size: 12, weight: .medium, design: .rounded))
            .foregroundStyle(HostPalette.rose)
            .padding(.horizontal, 15)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(HostPalette.rose.opacity(0.09)))
    }
}

struct CapabilityStatusPill: View {
    let enabled: Bool
    let enabledLabel: String
    let disabledLabel: String

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(enabled ? HostPalette.mint : HostPalette.amber)
                .frame(width: 7, height: 7)
            Text(enabled ? enabledLabel : disabledLabel)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
        }
        .foregroundStyle(enabled ? HostPalette.mint : HostPalette.amber)
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(Capsule().fill(Color.white.opacity(0.24)))
    }
}

struct BorrowedLightChoiceStrip<Value: Hashable>: View {
    let choices: [(value: Value, label: String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                Button {
                    withAnimation(.easeOut(duration: 0.16)) {
                        selection = choice.value
                    }
                } label: {
                    Text(choice.label)
                        .font(.system(size: 11.5, weight: selection == choice.value ? .semibold : .medium, design: .rounded))
                        .foregroundStyle(selection == choice.value ? HostPalette.lavenderDeep : HostPalette.secondaryInk)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background {
                            if selection == choice.value {
                                Capsule()
                                    .fill(Color.white.opacity(0.58))
                                    .overlay(Capsule().stroke(Color.white.opacity(0.72), lineWidth: 0.65))
                                    .shadow(color: HostPalette.lavenderDeep.opacity(0.08), radius: 8, y: 3)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == choice.value ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Capsule().fill(Color.white.opacity(0.24)))
        .overlay(Capsule().stroke(Color.white.opacity(0.46), lineWidth: 0.65))
    }
}

struct StatTile: View {
    let label: String
    let value: String
    let detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
            Text(value)
                .font(.system(size: 23, weight: .medium, design: .rounded))
                .foregroundStyle(HostPalette.ink)
                .contentTransition(.numericText())
            if let detail {
                Text(detail)
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.56))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.20)))
    }
}

@MainActor
enum HostFormat {
    static let byteFormatter: ByteCountFormatter = {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB, .useTB]
        formatter.countStyle = .file
        return formatter
    }()

    static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    static func bytes(_ count: Int64) -> String {
        byteFormatter.string(fromByteCount: count)
    }

    static func date(_ milliseconds: Int64) -> String {
        dateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000))
    }

    static func duration(_ seconds: Int64?) -> String {
        guard let seconds else { return L10n.unlimited }
        if seconds % 86_400 == 0 { return L10n.days(seconds / 86_400) }
        if seconds % 3_600 == 0 { return L10n.hours(seconds / 3_600) }
        return L10n.minutes(max(1, seconds / 60))
    }
}
