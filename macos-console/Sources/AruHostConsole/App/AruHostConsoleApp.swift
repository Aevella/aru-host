import SwiftUI

@main
struct AruHostConsoleApp: App {
    @State private var runtime = HostConsoleRuntime()
    @StateObject private var updates = HostUpdateCoordinator()

    var body: some Scene {
        WindowGroup {
            AruHostConsoleView(runtime: runtime, updates: updates)
                .frame(minWidth: 1040, minHeight: 680)
                .task {
                    async let startHost: Void = runtime.start()
                    async let checkUpdates: Void = updates.check()
                    _ = await (startHost, checkUpdates)
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1180, height: 760)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) { }
            CommandGroup(after: .toolbar) {
                Button(L10n.refresh) {
                    Task { await runtime.refresh(forceDriverProbe: false) }
                }
                .keyboardShortcut("r", modifiers: .command)
            }
            CommandGroup(after: .appInfo) {
                Button(L10n.checkForUpdates) {
                    Task { await updates.check() }
                }
            }
        }
    }
}
