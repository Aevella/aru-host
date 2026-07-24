import SwiftUI

struct StudioTextField: View {
    let placeholder: String
    @Binding var text: String
    let symbol: String
    let weight: Font.Weight

    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isFocused
                                 ? HostPalette.lavenderDeep.opacity(0.82)
                                 : HostPalette.secondaryInk.opacity(0.42))
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5, weight: weight, design: .rounded))
                .foregroundStyle(HostPalette.ink)
                .focused($isFocused)
                .focusEffectDisabled()
        }
        .padding(.horizontal, 13)
        .frame(minHeight: 40)
        .background {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.white.opacity(isFocused ? 0.44 : 0.30))
                .overlay {
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .stroke(
                            isFocused
                            ? HostPalette.lavender.opacity(0.34)
                            : Color.white.opacity(0.54),
                            lineWidth: isFocused ? 1.0 : 0.7)
                }
                .shadow(
                    color: isFocused
                    ? HostPalette.lavenderDeep.opacity(0.10)
                    : Color.clear,
                    radius: 10,
                    y: 4)
        }
        .animation(.easeOut(duration: 0.16), value: isFocused)
    }
}

struct StudioIconButtonStyle: ButtonStyle {
    var tint = Color.white.opacity(0.12)

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(HostPalette.ink.opacity(0.82))
            .frame(width: 34, height: 34)
            .background {
                Circle()
                    .fill(Color.white.opacity(configuration.isPressed ? 0.42 : 0.24))
                    .overlay {
                        Circle().fill(tint)
                    }
                    .overlay {
                        Circle().stroke(Color.white.opacity(0.62), lineWidth: 0.7)
                    }
                    .shadow(color: HostPalette.lavenderDeep.opacity(0.08), radius: 7, y: 3)
            }
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}
