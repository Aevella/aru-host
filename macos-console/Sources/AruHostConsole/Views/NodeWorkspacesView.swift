import AppKit
import SwiftUI

struct NodeWorkspacesView: View {
    @ObservedObject var runtime: HostConsoleRuntime
    @State private var revocationCandidate: HostNodeWorkspace?
    @State private var mutationError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HostSectionHeader(
                    title: L10n.computerFolders,
                    subtitle: L10n.computerFoldersSubtitle
                )

                if let error = runtime.sectionErrors[.workspaces] ?? mutationError {
                    SectionErrorBanner(message: error)
                }

                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L10n.authorizedFolders)
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        Text(L10n.folderAuthorityDescription)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                    }
                    Spacer()
                    Button {
                        chooseFolder()
                    } label: {
                        HStack(spacing: 7) {
                            if runtime.isUpdatingWorkspaces { ProgressView().controlSize(.small) }
                            Label(L10n.addFolder, systemImage: "folder.badge.plus")
                        }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.22)))
                    .disabled(runtime.isUpdatingWorkspaces)
                }

                if runtime.workspaces.isEmpty {
                    EmptySectionState(
                        symbol: "folder.badge.plus",
                        title: L10n.noAuthorizedFolders,
                        detail: L10n.noAuthorizedFoldersDetail
                    )
                } else {
                    ReadablePanel {
                        VStack(spacing: 0) {
                            ForEach(runtime.workspaces) { workspace in
                                workspaceRow(workspace)
                                if workspace.id != runtime.workspaces.last?.id {
                                    Divider().padding(.leading, 46).overlay(Color.white.opacity(0.40))
                                }
                            }
                        }
                    }
                }
            }
            .padding(30)
        }
        .confirmationDialog(
            L10n.revokeFolderTitle,
            isPresented: Binding(get: { revocationCandidate != nil },
                                 set: { if !$0 { revocationCandidate = nil } }),
            titleVisibility: .visible,
            presenting: revocationCandidate
        ) { workspace in
            Button(L10n.revoke, role: .destructive) {
                revocationCandidate = nil
                mutationError = nil
                Task {
                    do { try await runtime.revokeWorkspace(workspace) }
                    catch { mutationError = error.localizedDescription }
                }
            }
            Button(L10n.cancel, role: .cancel) { revocationCandidate = nil }
        } message: { workspace in
            Text(String(format: L10n.revokeFolderMessage, workspace.displayName))
        }
    }

    private func workspaceRow(_ workspace: HostNodeWorkspace) -> some View {
        HStack(spacing: 14) {
            StatusGlyph(state: .ready)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(workspace.displayName)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    if workspace.isDefault {
                        Text(L10n.defaultWorkspace)
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.lavender)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(HostPalette.lavender.opacity(0.12), in: Capsule())
                    }
                }
                Text(workspace.rootDisplayPath)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.65))
                    .lineLimit(2)
                    .textSelection(.enabled)
                Text(workspace.permissions.joined(separator: " · "))
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.5))
            }
            Spacer()
            Button(L10n.openInFinder) {
                openInFinder(workspace)
            }
            .buttonStyle(.plain)
            .foregroundStyle(HostPalette.lavender)
            if !workspace.isDefault {
                Button(L10n.revoke, role: .destructive) {
                    revocationCandidate = workspace
                }
                .buttonStyle(.plain)
                .foregroundStyle(HostPalette.rose)
                .disabled(runtime.isUpdatingWorkspaces)
            }
        }
        .padding(.vertical, 11)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        mutationError = nil
        Task {
            do { try await runtime.authorizeWorkspace(url) }
            catch { mutationError = error.localizedDescription }
        }
    }

    private func openInFinder(_ workspace: HostNodeWorkspace) {
        let path = (workspace.rootDisplayPath as NSString).expandingTildeInPath
        NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true))
    }
}
