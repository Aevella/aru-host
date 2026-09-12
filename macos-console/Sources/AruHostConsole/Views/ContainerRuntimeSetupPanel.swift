import SwiftUI

struct ContainerRuntimeSetupPanel: View {
    let runtime: HostConsoleRuntime
    @State private var preparing = false
    @State private var message: String?

    var body: some View {
        ReadablePanel {
            VStack(alignment: .leading, spacing: 12) {
                Text(L10n.containerSetupTitle).font(.headline)
                Text(L10n.containerSetupDetail)
                Text(L10n.containerSetupSteps)
                Text(L10n.containerSetupCost).font(.callout)
                HStack {
                    Link(L10n.containerSetupInstall, destination: URL(string: "https://podman-desktop.io/docs/installation/macos-install")!)
                    Button(preparing ? L10n.containerSetupBusy : L10n.containerSetupVerify) {
                        preparing = true
                        message = nil
                        Task {
                            defer { preparing = false }
                            do {
                                try await HostContainerRuntimeSetup.shared.prepare()
                                await runtime.refresh(forceDriverProbe: false)
                                message = L10n.containerSetupSuccess
                            } catch { message = error.localizedDescription }
                        }
                    }
                    .disabled(preparing)
                    .buttonStyle(FloatingGlassButtonStyle())
                    if preparing { ProgressView().controlSize(.small) }
                }
                if let message { Text(message).textSelection(.enabled) }
            }
            .foregroundStyle(HostPalette.ink)
        }
    }
}
