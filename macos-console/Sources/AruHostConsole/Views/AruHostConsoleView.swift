import SwiftUI

struct AruHostConsoleView: View {
    @ObservedObject var runtime: HostConsoleRuntime
    @ObservedObject var updates: HostUpdateCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: HostConsoleSection = .overview

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            WindowChromeConfigurator().frame(width: 0, height: 0)

            FoundationGlass {
                VStack(spacing: 0) {
                    header
                    Divider().overlay(Color.white.opacity(0.42))
                    content
                }
            }
            .padding(22)
        }
        .preferredColorScheme(.light)
        .task(id: selection) {
            await keepVisibleSectionFresh(selection)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, runtime.phase == .ready else { return }
            Task { await runtime.refresh(selection) }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(Color.white.opacity(0.36))
                Image(systemName: "sparkles")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(HostPalette.lavenderDeep)
            }
            .frame(width: 38, height: 38)

            VStack(alignment: .leading, spacing: 2) {
                Text(L10n.appName)
                    .font(.system(size: 18, weight: .medium, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(L10n.appSubtitle)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
            }

            if let nodeName = runtime.manifest?.displayName, runtime.phase == .ready {
                Text(nodeName)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                    .padding(.leading, 8)
            }

            Spacer()

            if case .available(let update) = updates.state {
                Button(L10n.updateAvailable(update.version)) {
                    updates.open(update)
                }
                .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.20)))
            }

            if runtime.isRefreshing || !runtime.loadingSections.isEmpty {
                ProgressView()
                    .controlSize(.small)
                    .tint(HostPalette.lavenderDeep)
            }

            if let lastUpdated = runtime.lastUpdated {
                Text(lastUpdated, style: .relative)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
            }
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 18)
    }

    @ViewBuilder
    private var content: some View {
        switch runtime.phase {
        case .preparingHost:
            preparingHostView
        case .loading:
            loadingView
        case .credentialFailure(let message):
            credentialErrorView(message)
        case .failure(let message):
            errorView(message)
        case .ready:
            HStack(spacing: 0) {
                HostConsoleSidebar(selection: $selection, runtime: runtime)
                Divider().overlay(Color.white.opacity(0.42))
                selectedSection
                    .id(selection)
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var preparingHostView: some View {
        VStack(spacing: 18) {
            ProgressView().controlSize(.large).tint(HostPalette.lavenderDeep)
            Text(L10n.preparingHostCore)
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk)
            Text(L10n.preparingHostCoreDetail)
                .font(.system(size: 12, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 440)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var selectedSection: some View {
        switch selection {
        case .overview:
            HostOverviewView(runtime: runtime) {
                withAnimation(.snappy(duration: 0.24)) { selection = .collaborators }
            }
        case .backups: BackupVaultView(runtime: runtime)
        case .mcp: MCPGatewayView(runtime: runtime)
        case .plugins: PluginSupervisorView(runtime: runtime)
        case .workspaces: NodeWorkspacesView(runtime: runtime)
        case .runtime: WorkspaceRuntimeView(runtime: runtime)
        case .artifacts: ArtifactVaultView(runtime: runtime)
        case .collaborators: HostedCollaboratorsView(runtime: runtime)
        }
    }

    private var loadingView: some View {
        VStack(spacing: 18) {
            ProgressView().controlSize(.large).tint(HostPalette.lavenderDeep)
            Text(L10n.findingHost)
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 18) {
            StatusGlyph(state: .unavailable).scaleEffect(1.35)
            Text(L10n.hostUnavailable)
                .font(.system(size: 24, weight: .light, design: .rounded))
                .foregroundStyle(HostPalette.ink)
            Text(message)
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 480)
            Button(L10n.tryAgain) {
                Task { await runtime.start() }
            }
            .buttonStyle(FloatingGlassButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
    }

    private func credentialErrorView(_ message: String) -> some View {
        VStack(spacing: 18) {
            StatusGlyph(state: .unavailable).scaleEffect(1.35)
            Text(L10n.secureConnectionUnavailable)
                .font(.system(size: 24, weight: .light, design: .rounded))
                .foregroundStyle(HostPalette.ink)
            Text(message)
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 480)
            Button(L10n.repairConnection) {
                Task { await runtime.repairLocalConnection() }
            }
            .buttonStyle(FloatingGlassButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
    }

    private func keepVisibleSectionFresh(_ section: HostConsoleSection) async {
        while !Task.isCancelled {
            if scenePhase == .active, runtime.phase == .ready {
                await runtime.refresh(section)
            }
            try? await Task.sleep(for: .seconds(section.automaticRefreshSeconds))
        }
    }
}
