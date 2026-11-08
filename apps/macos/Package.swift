// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DocifyAdmin",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "DocifyAdmin", path: "Sources/DocifyAdmin")
    ]
)
