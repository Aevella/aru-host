import SwiftUI

struct HostedCollaboratorsView: View {
    let runtime: HostConsoleRuntime
    @StateObject private var providerRuntime = HostProviderProfileRuntime()
    @State private var presentsCreateCollaborator = false
    @State private var selectedCollaborator: HostedCollaborator?
    @State private var bindingCollaborator: HostedCollaborator?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HostSectionHeader(
                    title: L10n.computerCollaborators,
                    subtitle: L10n.collaboratorsSubtitle
                )
                if let error = runtime.sectionErrors[.collaborators] {
                    SectionErrorBanner(message: error)
                }

                driverPanel
                ProviderProfilesPanel(runtime: providerRuntime) {
                    await runtime.refresh(.collaborators)
                }
                collaboratorPanel
            }
            .padding(30)
        }
        .sheet(isPresented: $presentsCreateCollaborator) {
            CreateCollaboratorSheet(runtime: runtime, providerProfiles: providerRuntime.profiles)
        }
        .sheet(item: $selectedCollaborator) { collaborator in
            CollaboratorSurfaceStudioView(runtime: runtime, collaborator: collaborator)
        }
        .sheet(item: $bindingCollaborator) { collaborator in
            CollaboratorDriverBindingSheet(
                runtime: runtime,
                collaborator: collaborator,
                providerProfiles: providerRuntime.profiles
            )
        }
        .task {
            while !Task.isCancelled {
                await providerRuntime.refresh()
                try? await Task.sleep(for: .seconds(HostConsoleSection.collaborators.automaticRefreshSeconds))
            }
        }
    }

    private var driverPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.agentDrivers)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(driverPanelStatusText)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                }
                Spacer()
            }
            ReadablePanel {
                VStack(spacing: 0) {
                    ForEach(runtime.driverInventory?.drivers ?? []) { driver in
                        DriverRow(driver: driver)
                        if driver.id != runtime.driverInventory?.drivers.last?.id {
                            Divider().padding(.leading, 46).overlay(Color.white.opacity(0.40))
                        }
                    }
                }
            }
        }
    }

    private var driverPanelStatusText: String {
        if runtime.readyDriverCount > 0 { return L10n.executionReady }
        if runtime.executionEnabled { return L10n.driverNeedsAttention }
        return L10n.executionPending
    }

    private var collaboratorPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.computerCollaborators)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.readOnlyProjection)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                }
                Spacer()
                Button {
                    presentsCreateCollaborator = true
                } label: {
                    Label(L10n.newCollaborator, systemImage: "plus")
                }
                .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.22)))
            }

            if runtime.collaborators.isEmpty {
                EmptySectionState(
                    symbol: "person.crop.circle.badge.plus",
                    title: L10n.noCollaborators,
                    detail: L10n.noCollaboratorsDetail
                )
            } else {
                ReadablePanel {
                    VStack(spacing: 0) {
                        ForEach(runtime.collaborators) { collaborator in
                            HStack(spacing: 8) {
                                Button {
                                    selectedCollaborator = collaborator
                                } label: {
                                    CollaboratorRow(
                                        collaborator: collaborator,
                                        providerProfile: providerRuntime.profiles.first {
                                            $0.profileId == collaborator.providerProfileId
                                        },
                                        surfaceCount: runtime.collaboratorSurfaces[collaborator.id]?.count ?? 0,
                                        conversations: runtime.collaboratorConversations[collaborator.id] ?? [])
                                }
                                .buttonStyle(.plain)
                                Button {
                                    bindingCollaborator = collaborator
                                } label: {
                                    Image(systemName: "slider.horizontal.3")
                                        .frame(width: 32, height: 32)
                                }
                                .buttonStyle(StudioIconButtonStyle())
                                .help(L10n.editCollaboratorDriver)
                            }
                            if collaborator.id != runtime.collaborators.last?.id {
                                Divider().padding(.leading, 46).overlay(Color.white.opacity(0.40))
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct DriverRow: View {
    let driver: AgentDriver

    var body: some View {
        HStack(spacing: 14) {
            StatusGlyph(state: driver.status == .ready ? .ready : driver.status == .unavailable ? .waiting : .unavailable)
            VStack(alignment: .leading, spacing: 3) {
                Text(driver.displayName)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(detail)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.65))
                    .lineLimit(1)
            }
            Spacer()
            Text(statusLabel)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(driver.status == .ready ? HostPalette.mint : HostPalette.amber)
        }
        .padding(.vertical, 11)
    }

    private var detail: String {
        if let version = driver.version, !version.isEmpty { return version }
        if isDirectAPI, driver.failure == "provider-profile-required" {
            return L10n.providerDriverNeedsProfile
        }
        if isDirectAPI, driver.failure?.contains("keychain") == true {
            return L10n.providerKeychainUnavailable
        }
        if driver.failure == "command-not-found" { return L10n.commandNotFound }
        return driver.failure ?? L10n.driverNeedsAttention
    }

    private var statusLabel: String {
        switch driver.status {
        case .ready: L10n.ready
        case .unavailable: isDirectAPI ? L10n.notConfigured : L10n.notInstalled
        case .unhealthy: L10n.needsAttention
        }
    }

    private var isDirectAPI: Bool {
        driver.id == "api" || driver.adapter == "direct-provider-api"
    }
}

private struct CollaboratorRow: View {
    let collaborator: HostedCollaborator
    let providerProfile: HostProviderProfile?
    let surfaceCount: Int
    let conversations: [HostCollaboratorConversation]

    var body: some View {
        HStack(spacing: 14) {
            HostedCollaboratorAvatar(
                collaborator: collaborator,
                size: 42,
                statusColor: statusTint
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(collaborator.displayName)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(driverDetail)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.65))
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(L10n.conversationAndSurfaceCount(conversations.count, surfaceCount: surfaceCount))
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.lavender)
                Text(statusLabel)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(statusTint)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.4))
        }
        .padding(.vertical, 11)
    }

    private var driverDetail: String {
        if collaborator.driverId == "api", let providerProfile {
            return L10n.providerDriverName(providerProfile.displayName, model: providerProfile.model)
        }
        return L10n.driverName(collaborator.driverId)
    }

    private var pendingApprovalCount: Int {
        conversations.reduce(0) { $0 + $1.pendingApprovalCount }
    }

    private var statusLabel: String {
        if pendingApprovalCount > 0 {
            return L10n.pendingApprovalCount(pendingApprovalCount)
        }
        if collaborator.activationStatus == "driver-unhealthy" {
            return L10n.needsAttention
        }
        return collaborator.turnExecution ? L10n.canReply : L10n.executionPendingShort
    }

    private var statusTint: Color {
        pendingApprovalCount > 0 || !collaborator.turnExecution
            || collaborator.activationStatus == "driver-unhealthy"
            ? HostPalette.amber
            : HostPalette.mint
    }
}

private struct CreateCollaboratorSheet: View {
    let runtime: HostConsoleRuntime
    let providerProfiles: [HostProviderProfile]
    @Environment(\.dismiss) private var dismiss
    @State private var displayName = ""
    @State private var driverId = "codex"
    @State private var providerProfileId = ""
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(L10n.newComputerCollaborator)
                        .font(.system(size: 25, weight: .light, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.newCollaboratorExplanation)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                }

                TextField(L10n.collaboratorName, text: $displayName)
                    .textFieldStyle(.roundedBorder)

                BorrowedLightChoiceStrip(
                    choices: (runtime.driverInventory?.drivers ?? []).map {
                        (value: $0.id, label: $0.displayName)
                    },
                    selection: $driverId
                )

                if driverId == "api" {
                    Picker(L10n.providerProfile, selection: $providerProfileId) {
                        if providerProfiles.isEmpty {
                            Text(L10n.noProviderProfilesShort).tag("")
                        } else {
                            ForEach(providerProfiles) { profile in
                                Text("\(profile.displayName) · \(profile.model)").tag(profile.profileId)
                            }
                        }
                    }
                    .onAppear {
                        if providerProfileId.isEmpty { providerProfileId = providerProfiles.first?.profileId ?? "" }
                    }
                }

                if !runtime.executionEnabled {
                    Label(L10n.executionFoundationPending, systemImage: "clock.badge.exclamationmark")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(HostPalette.amber)
                }

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
                                try await runtime.createCollaborator(
                                    displayName: displayName,
                                    driverId: driverId,
                                    providerProfileId: driverId == "api" ? providerProfileId : nil
                                )
                                dismiss()
                            } catch {
                                errorMessage = error.localizedDescription
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if runtime.isCreatingCollaborator { ProgressView().controlSize(.small) }
                            Text(L10n.create)
                        }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.28)))
                    .disabled(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || (driverId == "api" && providerProfileId.isEmpty)
                              || runtime.isCreatingCollaborator)
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
        .frame(width: 480, height: 420)
        .preferredColorScheme(.light)
    }
}

private struct CollaboratorDriverBindingSheet: View {
    let runtime: HostConsoleRuntime
    let collaborator: HostedCollaborator
    let providerProfiles: [HostProviderProfile]

    @Environment(\.dismiss) private var dismiss
    @State private var driverId: String
    @State private var providerProfileId: String
    @State private var errorMessage: String?

    init(
        runtime: HostConsoleRuntime,
        collaborator: HostedCollaborator,
        providerProfiles: [HostProviderProfile]
    ) {
        self.runtime = runtime
        self.collaborator = collaborator
        self.providerProfiles = providerProfiles
        _driverId = State(initialValue: collaborator.driverId)
        _providerProfileId = State(
            initialValue: collaborator.providerProfileId ?? providerProfiles.first?.profileId ?? ""
        )
    }

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(L10n.editCollaboratorDriver)
                        .font(.system(size: 25, weight: .light, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.editCollaboratorDriverDetail(collaborator.displayName))
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                }

                BorrowedLightChoiceStrip(
                    choices: (runtime.driverInventory?.drivers ?? []).map {
                        (value: $0.id, label: $0.displayName)
                    },
                    selection: $driverId
                )

                if driverId == "api" {
                    Picker(L10n.providerProfile, selection: $providerProfileId) {
                        ForEach(providerProfiles) { profile in
                            Text("\(profile.displayName) · \(profile.model)").tag(profile.profileId)
                        }
                    }
                }

                if let errorMessage { SectionErrorBanner(message: errorMessage) }

                Spacer()
                HStack {
                    Button(L10n.cancel) { dismiss() }
                        .buttonStyle(FloatingGlassButtonStyle())
                    Spacer()
                    Button(L10n.save) {
                        Task { await save() }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.28)))
                    .disabled((driverId == "api" && providerProfileId.isEmpty)
                              || runtime.mutatingCollaboratorIds.contains(collaborator.id))
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
        .frame(width: 520, height: 390)
        .preferredColorScheme(.light)
    }

    private func save() async {
        errorMessage = nil
        do {
            try await runtime.updateCollaboratorDriver(
                for: collaborator,
                driverId: driverId,
                providerProfileId: driverId == "api" ? providerProfileId : nil
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
