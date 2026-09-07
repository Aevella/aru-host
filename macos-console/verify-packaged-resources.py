#!/usr/bin/env python3
"""Verify built Host resources in .app layout without starting Host Core.

Pass the AruHostConsole_AruHostConsole.bundle produced by swift build/test.
The probe compiles production resource/locale/avatar loading code, with an
unavailable SwiftPM fallback, to model a customer machine without build files.
"""
import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("resource_bundle", type=Path)
args = parser.parse_args()
source = Path(__file__).resolve().parent / "Sources/AruHostConsole"
with tempfile.TemporaryDirectory(prefix="aru-host-packaged-resources-") as temp:
    root = Path(temp)
    app = root / "Probe.app/Contents"
    (app / "MacOS").mkdir(parents=True)
    (app / "Resources").mkdir()
    shutil.copytree(args.resource_bundle, app / "Resources/AruHostConsole_AruHostConsole.bundle")
    (app / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleExecutable": "Probe",
        "CFBundleIdentifier": "test.aru.packaged-resources",
        "CFBundlePackageType": "APPL",
    }))
    for name in ["HostConsoleResources.swift", "L10n.swift"]:
        shutil.copy(source / name, root / name)
    # Compile the actual loader without the unrelated SwiftUI row/model graph.
    avatar = (source / "Views/HostedCollaboratorAvatar.swift").read_text()
    loader, separator, _ = avatar.partition("struct HostedCollaboratorAvatar: View")
    if not separator:
        raise RuntimeError("Avatar source boundary changed; update the probe")
    (root / "Avatar.swift").write_text(loader)
    (root / "ResourceAccessor.swift").write_text('''import Foundation
extension Bundle {
    static var module: Bundle {
        fatalError("Unexpected SwiftPM fallback in a distributed app")
    }
}
''')
    (root / "main.swift").write_text('''import Foundation
import AppKit
MainActor.assumeIsolated {
var found: Set<String> = []
for index in 0..<1000 {
    let seed = "hostcol_\\(index)"
    guard HostCollaboratorAvatarPreset.image(for: seed) != nil else {
        fatalError("Missing packaged avatar")
    }
    found.insert(HostCollaboratorAvatarPreset.assetName(for: seed))
}
precondition(found.count == 36)
precondition(!L10n.computerCollaborators.isEmpty)
precondition(L10n.computerCollaborators != "computer.collaborators")
print("PASS: all 36 packaged avatars and localization; SwiftPM fallback unavailable")
}
''')
    executable = app / "MacOS/Probe"
    subprocess.run(["xcrun", "swiftc", *map(str, sorted(root.glob("*.swift"))),
                    "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
