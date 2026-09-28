import SwiftUI

struct HostCoreInstallationPanel: View {
    let runtime: HostConsoleRuntime
    let preparation: HostCorePreparation

    var body: some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 12) {
                Text(preparation.owner == .desktop ? L10n.hostDesktopOwned : L10n.hostIndependentOwned)
                    .font(.headline)
                Text(preparation.instance).font(.caption).foregroundStyle(HostPalette.secondaryInk)
                if let version = preparation.updateVersion {
                    Text(preparation.operation == .repair ? L10n.hostRepairDetail : L10n.hostCoreUpdateDetail)
                    Button { Task { await runtime.updateLocalCore() } } label: {
                        Text((preparation.operation == .repair ? L10n.hostCoreRepair : L10n.hostCoreUpdate) + " · " + version)
                    }
                    .buttonStyle(FloatingGlassButtonStyle())
                }
            }
            .foregroundStyle(HostPalette.ink)
        }
    }
}
