import SwiftUI

struct HostConsoleSidebar: View {
    @Binding var selection: HostConsoleSection
    let runtime: HostConsoleRuntime

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(spacing: 5) {
                ForEach(HostConsoleSection.allCases) { section in
                    Button {
                        withAnimation(.snappy(duration: 0.24)) { selection = section }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: section.symbol)
                                .font(.system(size: 14, weight: .medium))
                                .frame(width: 22)
                            Text(section.title)
                                .font(.system(size: 13, weight: selection == section ? .semibold : .medium, design: .rounded))
                            Spacer()
                            if let badge = badge(for: section) {
                                Text(badge)
                                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                            }
                            if runtime.sectionErrors[section] != nil {
                                Circle().fill(HostPalette.rose).frame(width: 6, height: 6)
                            }
                        }
                        .foregroundStyle(HostPalette.ink.opacity(selection == section ? 1 : 0.72))
                        .padding(.horizontal, 13)
                        .frame(height: 43)
                        .background {
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(selection == section ? Color.white.opacity(0.34) : .clear)
                                .overlay {
                                    if selection == section {
                                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                                            .stroke(Color.white.opacity(0.54), lineWidth: 0.65)
                                    }
                                }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer()

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    Circle().fill(HostPalette.mint).frame(width: 7, height: 7)
                    Text(L10n.hostCoreRunning)
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                }
                Text(runtime.manifest?.serverVersion ?? "—")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.55))
            }
            .foregroundStyle(HostPalette.secondaryInk)
            .padding(.horizontal, 13)
            .padding(.bottom, 8)
        }
        .padding(16)
        .frame(width: 224)
    }

    private func badge(for section: HostConsoleSection) -> String? {
        switch section {
        case .overview: nil
        case .backups: "\(runtime.backups.count)"
        case .mcp: runtime.mcpGateway.map { "\($0.tools.count)" }
        case .plugins: "\(runtime.plugins.count)"
        case .workspaces: "\(runtime.workspaces.count)"
        case .runtime: runtime.diagnostics.map { "\($0.activeJobCount)" }
        case .artifacts: "\(runtime.artifacts.count)"
        case .collaborators: "\(runtime.collaborators.count)"
        }
    }
}
