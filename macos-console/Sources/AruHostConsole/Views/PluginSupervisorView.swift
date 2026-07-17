import SwiftUI

struct PluginSupervisorView: View {
    @ObservedObject var runtime: HostConsoleRuntime
    @State private var selectedPluginID: String?
    @State private var editorSeed: PluginEditorSeed?
    @State private var confirmation: PluginConfirmation?

    private var selectedPlugin: HostPlugin? {
        let requested = selectedPluginID.flatMap { id in runtime.plugins.first { $0.id == id } }
        return requested ?? runtime.plugins.first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HostSectionHeader(
                    title: L10n.plugins,
                    subtitle: L10n.pluginsSubtitle,
                    isLoading: runtime.loadingSections.contains(.plugins)
                ) {
                    Task { await runtime.refresh(.plugins) }
                }

                actionBar

                if let message = runtime.pluginActionMessage {
                    PluginActionBanner(message: message, failed: runtime.pluginActionFailed) {
                        runtime.clearPluginActionMessage()
                    }
                } else if let error = runtime.sectionErrors[.plugins] {
                    SectionErrorBanner(message: error)
                }

                supervisorSummary
                metrics

                if !runtime.pluginDrafts.isEmpty {
                    draftSection
                }

                if runtime.plugins.isEmpty {
                    EmptySectionState(
                        symbol: "puzzlepiece.extension",
                        title: L10n.noPlugins,
                        detail: L10n.noPluginsDetail
                    )
                } else {
                    installedSection
                }
            }
            .padding(30)
        }
        .sheet(item: $editorSeed) { seed in
            PluginEditorSheet(runtime: runtime, seed: seed)
        }
        .confirmationDialog(
            confirmation?.title ?? "",
            isPresented: Binding(
                get: { confirmation != nil },
                set: { if !$0 { confirmation = nil } }
            ),
            titleVisibility: .visible
        ) {
            confirmationButtons
        }
        .onAppear {
            if selectedPluginID == nil { selectedPluginID = runtime.plugins.first?.id }
        }
        .onChange(of: runtime.plugins.map(\.id)) { _, ids in
            if let selectedPluginID, !ids.contains(selectedPluginID) {
                self.selectedPluginID = ids.first
            } else if selectedPluginID == nil {
                selectedPluginID = ids.first
            }
        }
    }

    private var actionBar: some View {
        HStack {
            Spacer()
            Button {
                editorSeed = .newPlugin
            } label: {
                Label(L10n.newPlugin, systemImage: "plus")
            }
            .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.18)))
        }
    }

    private var supervisorSummary: some View {
        ReadablePanel {
            HStack(spacing: 16) {
                StatusGlyph(state: runtime.capability("plugin-supervisor")?.enabled == true ? .ready : .waiting)
                VStack(alignment: .leading, spacing: 5) {
                    Text(L10n.pluginSupervisor)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.pluginSupervisorDescription)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.64))
                }
                Spacer()
                Text((runtime.capability("plugin-supervisor")?.packageModes ?? []).joined(separator: " · "))
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.56))
            }
        }
    }

    private var metrics: some View {
        HStack(spacing: 12) {
            StatTile(label: L10n.installedPlugins, value: "\(runtime.plugins.count)", detail: nil)
            StatTile(
                label: L10n.activePlugins,
                value: "\(runtime.plugins.filter { $0.health == "running" }.count)",
                detail: nil
            )
            StatTile(
                label: L10n.exposedTools,
                value: "\(runtime.plugins.filter { $0.health == "running" }.flatMap(\.tools).count)",
                detail: nil
            )
            StatTile(
                label: L10n.attentionPlugins,
                value: "\(runtime.plugins.filter { $0.health == "unhealthy" }.count)",
                detail: runtime.pluginDrafts.isEmpty ? nil : "\(runtime.pluginDrafts.count) \(L10n.pluginDrafts)"
            )
        }
    }

    private var draftSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.pluginDrafts)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(L10n.optionalCheckpoints)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
            }
            ForEach(runtime.pluginDrafts) { draft in
                PluginDraftRow(
                    draft: draft,
                    isBusy: runtime.mutatingPluginIds.contains(draft.id),
                    edit: { loadDraftForEditing(draft) },
                    apply: { run { _ = try await runtime.applyPluginDraft(draft) } },
                    delete: { confirmation = .deleteDraft(draft) }
                )
            }
        }
    }

    private var installedSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.installedPlugins)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .foregroundStyle(HostPalette.ink)
            HStack(alignment: .top, spacing: 14) {
                LazyVStack(spacing: 9) {
                    ForEach(runtime.plugins) { plugin in
                        PluginSelectionRow(
                            plugin: plugin,
                            selected: selectedPlugin?.id == plugin.id,
                            action: { selectedPluginID = plugin.id }
                        )
                    }
                }
                .frame(width: 286)

                if let selectedPlugin {
                    PluginDetailPanel(
                        plugin: selectedPlugin,
                        collaborators: runtime.collaborators,
                        isBusy: runtime.mutatingPluginIds.contains(selectedPlugin.id),
                        toggle: {
                            run { try await runtime.setPlugin(selectedPlugin, enabled: selectedPlugin.desiredState != "enabled") }
                        },
                        edit: { loadPluginForEditing(selectedPlugin) },
                        rollback: { confirmation = .rollback(selectedPlugin) },
                        uninstall: { confirmation = .uninstall(selectedPlugin) }
                    )
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    @ViewBuilder
    private var confirmationButtons: some View {
        switch confirmation {
        case .rollback(let plugin):
            Button(L10n.rollback) { run { try await runtime.rollbackPlugin(plugin) } }
        case .deleteDraft(let draft):
            Button(L10n.deleteDraft, role: .destructive) { run { try await runtime.deletePluginDraft(draft) } }
        case .uninstall(let plugin):
            Button(L10n.keepData, role: .destructive) {
                run { try await runtime.uninstallPlugin(plugin, deleteData: false) }
            }
            if plugin.dataPresent {
                Button(L10n.deleteData, role: .destructive) {
                    run { try await runtime.uninstallPlugin(plugin, deleteData: true) }
                }
            }
        case nil:
            EmptyView()
        }
        Button(L10n.cancel, role: .cancel) {}
    }

    private func loadDraftForEditing(_ draft: HostPluginDraft) {
        run {
            let full = try await runtime.loadPluginDraft(draft.id)
            guard let sourceCode = full.sourceCode else { throw HostConsoleHTTPError.invalidResponse }
            editorSeed = PluginEditorSeed(
                pluginId: full.pluginId,
                displayName: full.displayName,
                version: full.version,
                sourceCode: sourceCode,
                capabilities: Set(full.capabilities),
                locksIdentity: false
            )
        }
    }

    private func loadPluginForEditing(_ plugin: HostPlugin) {
        run {
            let source = try await runtime.loadPluginSource(plugin.id)
            editorSeed = PluginEditorSeed(
                pluginId: source.pluginId,
                displayName: source.displayName,
                version: source.version,
                sourceCode: source.sourceCode,
                capabilities: Set(source.capabilities),
                locksIdentity: true
            )
        }
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        confirmation = nil
        Task {
            do { try await operation() }
            catch { runtime.reportPluginActionFailure(error) }
        }
    }
}

private enum PluginConfirmation {
    case rollback(HostPlugin)
    case uninstall(HostPlugin)
    case deleteDraft(HostPluginDraft)

    var title: String {
        switch self {
        case .rollback: L10n.pluginRollbackTitle
        case .uninstall: L10n.pluginUninstallTitle
        case .deleteDraft: L10n.pluginDeleteDraftTitle
        }
    }
}
