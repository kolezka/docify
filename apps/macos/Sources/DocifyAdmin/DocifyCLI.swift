import Foundation

struct SourceInfo: Decodable, Identifiable, Hashable {
    struct Generation: Decodable, Hashable {
        let id: Int
        let status: String
        let phase: String?
        let progress: String?
        let error: String?
    }

    struct Active: Decodable, Hashable {
        let embeddingModel: String?
    }

    let id: String
    let library: String
    let version: String?
    let kind: String
    let locator: String
    let state: String
    let activeGeneration: Active?
    let latest: Generation?
}

struct CLIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Runs the `docify` CLI. GUI apps do not get the login shell PATH, so bun's bin dirs are added by hand.
enum DocifyCLI {
    static let executable: String = {
        if let custom = ProcessInfo.processInfo.environment["DOCIFY_BIN"] { return custom }
        return NSString(string: "~/.bun/bin/docify").expandingTildeInPath
    }()

    static var environment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        let extra = ["\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
        // Settings win over the inherited environment; empty settings leave it alone.
        let names = ConfigFile.credentialEnvNames((try? ConfigFile.load()) ?? [:])
        let url = Credentials.baseUrl, key = Credentials.apiKey
        if !url.isEmpty { names.urls.forEach { env[$0] = url } }
        if !key.isEmpty { names.keys.forEach { env[$0] = key } }
        return env
    }

    static func makeProcess(_ args: [String]) -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = args
        p.environment = environment
        return p
    }

    /// Runs a short command and returns stdout, or throws with stderr on a non-zero exit.
    static func run(_ args: [String]) async throws -> String {
        try await Task.detached {
            let p = makeProcess(args)
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            do { try p.run() } catch {
                throw CLIError(message: "cannot start \(executable): \(error.localizedDescription). Set DOCIFY_BIN or run `bun link`.")
            }
            // Drain both pipes while the child runs, or a full pipe buffer blocks it forever.
            var errData = Data()
            let errReader = Thread { errData = err.fileHandleForReading.readDataToEndOfFile() }
            errReader.start()
            let outData = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            while !errReader.isFinished { usleep(1000) }
            let stdout = String(decoding: outData, as: UTF8.self)
            guard p.terminationStatus == 0 else {
                let stderr = String(decoding: errData, as: UTF8.self)
                let msg = stderr.isEmpty ? stdout : stderr
                throw CLIError(message: msg.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            return stdout
        }.value
    }

    static func sources() async throws -> [SourceInfo] {
        let json = try await run(["sources", "--json"])
        return try JSONDecoder().decode([SourceInfo].self, from: Data(json.utf8))
    }
}
