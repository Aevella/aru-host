import SwiftUI

struct BackupVaultView: View {
    @ObservedObject var runtime: HostConsoleRuntime
    @State private var deleteCandidate: BackupPackage?
    @State private var mutationError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HostSectionHeader(
                    title: L10n.backupVault,
                    subtitle: L10n.backupSubtitle,
                    isLoading: runtime.loadingSections.contains(.backups)
                ) {
                    Task { await runtime.refresh(.backups) }
                }
                if let error = runtime.sectionErrors[.backups] ?? mutationError {
                    SectionErrorBanner(message: error)
                }

                HStack(spacing: 12) {
                    StatTile(label: L10n.encryptedPackages, value: "\(runtime.backups.count)", detail: L10n.clientEncrypted)
                    StatTile(label: L10n.totalStorage, value: HostFormat.bytes(totalBytes), detail: L10n.remoteCiphertext)
                    StatTile(label: L10n.latestBackup, value: latestDate, detail: runtime.backups.first?.metadata.sourceName)
                }

                BackupOrganizationPanel(runtime: runtime)

                if runtime.backups.isEmpty {
                    EmptySectionState(
                        symbol: "archivebox",
                        title: L10n.noBackups,
                        detail: L10n.noBackupsDetail
                    )
                } else {
                    VStack(spacing: 12) {
                        ForEach(runtime.backups) { package in
                            BackupPackageRow(
                                package: package,
                                isDeleting: runtime.mutatingBackupIds.contains(package.id),
                                delete: { deleteCandidate = package })
                        }
                    }
                }
            }
            .padding(30)
        }
        .confirmationDialog(
            L10n.deleteBackupTitle,
            isPresented: Binding(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }),
            titleVisibility: .visible,
            presenting: deleteCandidate
        ) { package in
            Button(L10n.deleteBackup, role: .destructive) {
                deleteCandidate = nil
                Task {
                    do {
                        try await runtime.deleteBackup(package)
                        mutationError = nil
                    } catch {
                        mutationError = error.localizedDescription
                    }
                }
            }
            Button(L10n.cancel, role: .cancel) { deleteCandidate = nil }
        } message: { _ in
            Text(L10n.deleteBackupMessage)
        }
    }

    private var totalBytes: Int64 {
        runtime.backups.reduce(0) { $0 + $1.metadata.packageByteCount }
    }

    private var latestDate: String {
        guard let latest = runtime.backups.first else { return "—" }
        return HostFormat.date(latest.uploadedAt)
    }
}

private struct BackupOrganizationPanel: View {
    @ObservedObject var runtime: HostConsoleRuntime
    @State private var keepEveryBackup = true
    @State private var keepLatestCount = 30
    @State private var error: String?

    var body: some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 15) {
                HStack(alignment: .top, spacing: 14) {
                    StatusGlyph(state: runtime.backupSettings == nil ? .waiting : .ready)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(L10n.backupOrganization)
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(L10n.backupOrganizationDescription)
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 12)
                    Text(L10n.backupSettingsShared)
                        .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.lavenderDeep)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(HostPalette.lavender.opacity(0.12)))
                }

                if let settings = runtime.backupSettings {
                    Toggle(L10n.keepEveryBackup, isOn: $keepEveryBackup)
                        .toggleStyle(.switch)
                        .tint(HostPalette.lavenderDeep)
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    if !keepEveryBackup {
                        Stepper(value: $keepLatestCount, in: 1...Int.max) {
                            Text(L10n.keepLatestBackups(keepLatestCount))
                                .font(.system(size: 13, design: .rounded))
                                .foregroundStyle(HostPalette.ink)
                        }
                    }

                    HStack(spacing: 12) {
                        if let lastAppliedAt = settings.lastAppliedAt {
                            Text(L10n.backupSettingsLastApplied(
                                HostFormat.date(lastAppliedAt),
                                deletedCount: settings.lastDeletedCount))
                                .font(.system(size: 11, design: .rounded))
                                .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                        }
                        Spacer()
                        Button(runtime.isUpdatingBackupSettings ? L10n.backupSettingsSaving : L10n.saveSettings) {
                            Task { await save() }
                        }
                        .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.22)))
                        .disabled(!canSave)
                    }
                } else {
                    HStack(spacing: 9) {
                        ProgressView().controlSize(.small)
                        Text(L10n.findingHost)
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                    }
                }

                if let error {
                    Text(error)
                        .font(.system(size: 11.5, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                }
            }
        }
        .onAppear { load() }
        .onChange(of: runtime.backupSettings?.revision) { _, _ in load() }
    }

    private var canSave: Bool {
        guard let settings = runtime.backupSettings,
              !runtime.isUpdatingBackupSettings else { return false }
        let mode: HostBackupRetentionMode = keepEveryBackup ? .keepAll : .keepLatest
        let count = keepEveryBackup ? nil : keepLatestCount
        return mode != settings.retentionMode || count != settings.keepLatestCount
    }

    private func load() {
        guard let settings = runtime.backupSettings else { return }
        keepEveryBackup = settings.retentionMode == .keepAll
        keepLatestCount = settings.keepLatestCount ?? 30
        error = nil
    }

    private func save() async {
        do {
            try await runtime.updateBackupSettings(
                retentionMode: keepEveryBackup ? .keepAll : .keepLatest,
                keepLatestCount: keepEveryBackup ? nil : keepLatestCount)
            error = nil
        } catch {
            self.error = error.localizedDescription
            await runtime.refresh(.backups)
        }
    }
}

private struct BackupPackageRow: View {
    let package: BackupPackage
    let isDeleting: Bool
    let delete: () -> Void

    var body: some View {
        ReadablePanel {
            HStack(alignment: .top, spacing: 16) {
                StatusGlyph(state: isDeleting ? .waiting : .ready)
                VStack(alignment: .leading, spacing: 7) {
                    Text(package.metadata.sourceName)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(HostFormat.date(package.uploadedAt))
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.61))
                    HStack(spacing: 15) {
                        Label(HostFormat.bytes(package.metadata.packageByteCount), systemImage: "lock.doc")
                        Label(L10n.objectCount(package.metadata.objectCounts.values.reduce(0, +)), systemImage: "square.stack.3d.up")
                        Label(L10n.attachmentCount(package.metadata.binaryCount), systemImage: "paperclip")
                    }
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 12) {
                    Text(package.remotePackageId.suffix(8))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.46))
                    Button(action: delete) {
                        Label(L10n.deleteBackup, systemImage: "trash")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.rose)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(HostPalette.rose.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                    .disabled(isDeleting)
                }
            }
        }
    }
}
