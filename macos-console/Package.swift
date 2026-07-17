// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AruHostConsole",
    defaultLocalization: "zh-Hans",
    platforms: [
        .macOS(.v26),
    ],
    products: [
        .executable(name: "AruHostConsole", targets: ["AruHostConsole"]),
    ],
    targets: [
        .executableTarget(
            name: "AruHostConsole",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "AruHostConsoleTests",
            dependencies: ["AruHostConsole"]
        ),
    ]
)
