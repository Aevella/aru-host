import SwiftUI
import AppKit
import CoreImage

struct HostOverviewView: View {
    let runtime: HostConsoleRuntime
    let onOpenCollaborators: () -> Void
    @State private var presentsRename = false
    @State private var presentsPairingCode = false
    @State private var presentsGettingStarted = false
    @State private var deviceToRevoke: HostPairedDevice?
    @State private var actionError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HostSectionHeader(
                    title: runtime.manifest?.displayName ?? L10n.thisMac,
                    subtitle: L10n.overviewSubtitle
                )

                if let error = runtime.sectionErrors[.overview] {
                    SectionErrorBanner(message: error)
                }
                if let actionError {
                    SectionErrorBanner(message: actionError)
                }

                hero
                gettingStartedPanel
                identityPanel
                accessPanel
                capabilityPanel
            }
            .padding(30)
        }
        .sheet(isPresented: $presentsRename) {
            RenameNodeSheet(runtime: runtime)
        }
        .sheet(isPresented: $presentsPairingCode) {
            HostPairingQRCodeSheet(runtime: runtime)
        }
        .sheet(isPresented: $presentsGettingStarted) {
            HostGettingStartedGuideView(
                runtime: runtime,
                onOpenCollaborators: onOpenCollaborators
            )
        }
        .alert(
            L10n.revokeDeviceTitle,
            isPresented: Binding(
                get: { deviceToRevoke != nil },
                set: { if !$0 { deviceToRevoke = nil } }
            ),
            presenting: deviceToRevoke
        ) { device in
            Button(L10n.cancel, role: .cancel) { deviceToRevoke = nil }
            Button(L10n.revoke, role: .destructive) {
                Task {
                    do {
                        try await runtime.revokeDevice(device)
                        actionError = nil
                    } catch {
                        actionError = error.localizedDescription
                    }
                    deviceToRevoke = nil
                }
            }
        } message: { device in
            Text(String(format: L10n.revokeDeviceMessage, device.label))
        }
    }

    private var identityPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(L10n.nodeIdentity)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(HostPalette.ink)

            ReadablePanel {
                HStack(spacing: 16) {
                    Image(systemName: "network.badge.shield.half.filled")
                        .font(.system(size: 25, weight: .light))
                        .foregroundStyle(HostPalette.lavenderDeep)
                        .frame(width: 38)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(runtime.nodeSettings?.displayName ?? runtime.manifest?.displayName ?? L10n.thisMac)
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(L10n.nodeIdentityDescription)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.65))
                    }
                    Spacer()
                    Button(L10n.rename) { presentsRename = true }
                        .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.20)))
                        .disabled(runtime.nodeSettings == nil || runtime.isUpdatingNodeSettings)
                }
            }
        }
    }

    private var accessPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .center, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.pairedDevices)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.pairedDevicesDescription)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                }
                Spacer()
                Button {
                    presentsPairingCode = true
                } label: {
                    Label(L10n.connectPhone, systemImage: "qrcode")
                }
                .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.22)))
            }

            if activeDevices.isEmpty {
                EmptySectionState(
                    symbol: "iphone.slash",
                    title: L10n.noPairedDevices,
                    detail: L10n.noPairedDevicesDetail
                )
            } else {
                ReadablePanel {
                    VStack(spacing: 0) {
                        ForEach(activeDevices) { device in
                            HStack(spacing: 14) {
                                StatusGlyph(state: .ready)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(device.label)
                                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                                        .foregroundStyle(HostPalette.ink)
                                    Text(HostFormat.date(device.issuedAt))
                                        .font(.system(size: 11, design: .rounded))
                                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                                }
                                Spacer()
                                if device.isCurrent {
                                    Text(L10n.thisConsole)
                                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                                        .foregroundStyle(HostPalette.mint)
                                } else {
                                    Button(L10n.revoke) { deviceToRevoke = device }
                                        .buttonStyle(FloatingGlassButtonStyle())
                                        .disabled(runtime.mutatingDeviceIds.contains(device.deviceId))
                                }
                            }
                            .padding(.vertical, 10)
                            if device.id != activeDevices.last?.id {
                                Divider().padding(.leading, 46).overlay(Color.white.opacity(0.40))
                            }
                        }
                    }
                }
            }
        }
    }

    private var activeDevices: [HostPairedDevice] {
        runtime.pairedDevices.filter(\.isActive)
    }

    private var gettingStartedPanel: some View {
        Button {
            presentsGettingStarted = true
        } label: {
            HStack(spacing: 18) {
                ZStack {
                    Circle()
                        .fill(Color.white.opacity(0.30))
                    Image(systemName: "moon.stars")
                        .font(.system(size: 22, weight: .light))
                        .foregroundStyle(HostPalette.lavenderDeep)
                }
                .frame(width: 48, height: 48)

                VStack(alignment: .leading, spacing: 5) {
                    Text(L10n.guideEntranceTitle)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.guideEntranceDetail)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                HStack(spacing: 8) {
                    Text(L10n.openGuide)
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(HostPalette.lavenderDeep)
            }
            .padding(20)
            .background {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(Color.white.opacity(0.23))
                    .overlay {
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .stroke(Color.white.opacity(0.48), lineWidth: 0.65)
                    }
            }
            .contentShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityHint(L10n.guideEntranceDetail)
    }

    private var hero: some View {
        ReadablePanel {
            HStack(spacing: 24) {
                ZStack {
                    Circle()
                        .fill(Color.white.opacity(0.30))
                        .glassEffect(.regular.tint(Color.white.opacity(0.12)), in: Circle())
                    Image(systemName: "server.rack")
                        .font(.system(size: 34, weight: .ultraLight))
                        .foregroundStyle(HostPalette.lavenderDeep)
                }
                .frame(width: 84, height: 84)

                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 10) {
                        Text(L10n.hostCore)
                            .font(.system(size: 21, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        CapabilityStatusPill(
                            enabled: runtime.diagnostics?.manifest == "ok" && runtime.diagnostics?.auth == "ok",
                            enabledLabel: L10n.running,
                            disabledLabel: L10n.needsAttention
                        )
                    }
                    Text(L10n.hostCoreDescription)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                }
                Spacer()
            }

            HStack(spacing: 12) {
                StatTile(label: L10n.backupVault, value: "\(runtime.diagnostics?.packageCount ?? runtime.backups.count)", detail: L10n.encryptedPackages)
                StatTile(label: L10n.mcpTools, value: "\(runtime.mcpGateway?.tools.count ?? 0)", detail: L10n.authenticatedGateway)
                StatTile(label: L10n.runningJobs, value: "\(runtime.diagnostics?.activeJobCount ?? 0)", detail: L10n.durableJobs)
                StatTile(label: L10n.pairedDevices, value: "\(runtime.diagnostics?.deviceCount ?? 0)", detail: L10n.authorizedDevices)
            }
            .padding(.top, 20)
        }
    }

    private var capabilityPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(L10n.installedCapabilities)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(HostPalette.ink)

            ReadablePanel {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 0) {
                    ForEach(sortedCapabilities, id: \.key) { id, capability in
                        HStack(spacing: 12) {
                            StatusGlyph(state: capability.enabled ? .ready : .waiting)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(capabilityName(id))
                                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                                    .foregroundStyle(HostPalette.ink)
                                Text(capability.enabled ? L10n.available : disabledReason(id))
                                    .font(.system(size: 10, design: .rounded))
                                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                            }
                            Spacer()
                        }
                        .padding(.vertical, 12)
                        .padding(.trailing, 18)
                    }
                }
            }
        }
    }

    private var sortedCapabilities: [(key: String, value: HostManifest.Capability)] {
        (runtime.manifest?.capabilities ?? [:]).sorted { $0.key < $1.key }
    }

    private func capabilityName(_ id: String) -> String {
        switch id {
        case "backup-vault": L10n.backupVault
        case "mcp-gateway": L10n.mcpGateway
        case "plugin-supervisor": L10n.pluginSupervisor
        case "workspace-runtime": L10n.workspaceRuntime
        case "job-runtime": L10n.jobRuntime
        case "artifact-vault": L10n.artifactVault
        case "collaborator-host": L10n.collaboratorHost
        case "node-settings": L10n.nodeIdentity
        case "sync-ledger": L10n.syncLedger
        default: id
        }
    }

    private func disabledReason(_ id: String) -> String {
        switch id {
        case "workspace-runtime", "job-runtime": L10n.containerRuntimeMissing
        case "sync-ledger": L10n.reserved
        default: L10n.disabled
        }
    }
}

struct HostPairingQRCodeSheet: View {
    let runtime: HostConsoleRuntime
    @Environment(\.dismiss) private var dismiss
    @State private var pairingLink: String?
    @State private var issuedAt: Date?
    @State private var now = Date()
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var copied = false
    private let clock = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(spacing: 22) {
                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(L10n.connectPhone)
                            .font(.system(size: 25, weight: .light, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(L10n.scanPairingDescription)
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button(L10n.close) { dismiss() }
                        .buttonStyle(FloatingGlassButtonStyle())
                }

                ReadablePanel {
                    VStack(spacing: 16) {
                        qrContent
                            .frame(width: 292, height: 292)

                        if pairingLink != nil {
                            HStack(spacing: 7) {
                                Circle()
                                    .fill(isExpired ? HostPalette.rose : HostPalette.mint)
                                    .frame(width: 7, height: 7)
                                Text(isExpired
                                     ? L10n.pairingCodeExpired
                                     : String(format: L10n.pairingCodeExpires, formattedRemainingTime))
                                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                                    .foregroundStyle(isExpired ? HostPalette.rose : HostPalette.secondaryInk)
                            }
                        }

                        if let errorMessage {
                            Text(errorMessage)
                                .font(.system(size: 11, design: .rounded))
                                .foregroundStyle(HostPalette.rose)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity)
                }

                HStack(spacing: 12) {
                    Button {
                        Task { await issueFreshCode() }
                    } label: {
                        Label(pairingLink == nil ? L10n.retry : L10n.refreshPairingCode,
                              systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(FloatingGlassButtonStyle())
                    .disabled(isLoading)

                    Button {
                        copyLink()
                    } label: {
                        Label(copied ? L10n.copied : L10n.copyPairingLink,
                              systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.24)))
                    .disabled(pairingLink == nil || isExpired)
                }
            }
            .padding(28)
        }
        .frame(width: 560, height: 620)
        .task { await issueFreshCode() }
        .onReceive(clock) { now = $0 }
    }

    @ViewBuilder
    private var qrContent: some View {
        if isLoading {
            ProgressView()
                .controlSize(.large)
                .tint(HostPalette.lavenderDeep)
        } else if let pairingLink,
                  let image = HostPairingQRCodeRenderer.image(for: pairingLink) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(20)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                .opacity(isExpired ? 0.28 : 1)
        } else {
            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 58, weight: .ultraLight))
                .foregroundStyle(HostPalette.rose)
        }
    }

    private var secondsRemaining: Int {
        guard let issuedAt else { return 0 }
        return max(0, Int(issuedAt.addingTimeInterval(600).timeIntervalSince(now)))
    }

    private var isExpired: Bool { secondsRemaining == 0 }

    private var formattedRemainingTime: String {
        String(format: "%d:%02d", secondsRemaining / 60, secondsRemaining % 60)
    }

    @MainActor
    private func issueFreshCode() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        copied = false
        defer { isLoading = false }
        do {
            pairingLink = try await runtime.issueMobilePairingLink()
            issuedAt = Date()
            now = Date()
        } catch {
            pairingLink = nil
            issuedAt = nil
            errorMessage = error.localizedDescription
        }
    }

    private func copyLink() {
        guard let pairingLink, !isExpired else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairingLink, forType: .string)
        copied = true
    }
}

private enum HostPairingQRCodeRenderer {
    static func image(for payload: String) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(payload.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)) else {
            return nil
        }
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = context.createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
    }
}

private struct RenameNodeSheet: View {
    let runtime: HostConsoleRuntime
    @Environment(\.dismiss) private var dismiss
    @State private var displayName = ""
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(L10n.renameNode)
                        .font(.system(size: 25, weight: .light, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.renameNodeDescription)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                }

                TextField(L10n.nodeName, text: $displayName)
                    .textFieldStyle(.roundedBorder)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                }

                HStack {
                    Button(L10n.cancel) { dismiss() }
                        .buttonStyle(FloatingGlassButtonStyle())
                    Spacer()
                    Button {
                        Task {
                            do {
                                try await runtime.updateNodeDisplayName(displayName)
                                dismiss()
                            } catch {
                                errorMessage = error.localizedDescription
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if runtime.isUpdatingNodeSettings { ProgressView().controlSize(.small) }
                            Text(L10n.saveSettings)
                        }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.28)))
                    .disabled(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || runtime.isUpdatingNodeSettings)
                }
            }
            .padding(30)
            .background {
                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .fill(Color.white.opacity(0.27))
                    .glassEffect(.regular.tint(Color.white.opacity(0.12)), in: RoundedRectangle(cornerRadius: 34))
            }
            .padding(18)
        }
        .frame(width: 480, height: 330)
        .preferredColorScheme(.light)
        .onAppear {
            displayName = runtime.nodeSettings?.displayName ?? runtime.manifest?.displayName ?? ""
        }
    }
}
