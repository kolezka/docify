import SwiftUI

/// docify's config.json, kept as a plain dictionary so keys this app does not know survive a save.
enum ConfigFile {
    static var home: URL {
        if let custom = ProcessInfo.processInfo.environment["DOCIFY_HOME"] { return URL(fileURLWithPath: custom) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/docify")
    }

    static var url: URL { home.appendingPathComponent("config.json") }

    /// A missing file is an empty config. A malformed one throws, so it is never overwritten blindly.
    static func load() throws -> [String: Any] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        let data = try Data(contentsOf: url)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CLIError(message: "\(url.path) is not a JSON object; fix or remove it first")
        }
        return dict
    }

    static func save(_ dict: [String: Any]) throws {
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: url, options: .atomic)
    }

    /// Variable names docify reads the LiteLLM URL and key from, for embeddings and the graph.
    static func credentialEnvNames(_ dict: [String: Any]) -> (urls: Set<String>, keys: Set<String>) {
        let graph = dict["graph"] as? [String: Any]
        let urls: Set<String> = [
            dict["embeddingBaseUrlEnv"] as? String ?? "LITELLM_BASE_URL",
            graph?["baseUrlEnv"] as? String ?? "LITELLM_BASE_URL",
        ]
        let keys: Set<String> = [
            dict["embeddingApiKeyEnv"] as? String ?? "LITELLM_API_KEY",
            graph?["apiKeyEnv"] as? String ?? "LITELLM_API_KEY",
        ]
        return (urls, keys)
    }
}

// Mirrors loadConfig() and DEFAULT_GRAPH in src/core/config.ts; keep them in step.
private enum Defaults {
    static let provider = "transformers"
    static let model = "Xenova/bge-small-en-v1.5"
    static let dims = 384
    static let prefix = "Represent this sentence for searching relevant passages: "
    static let ollamaUrl = "http://localhost:11434"
    static let strong = 0.65
    static let weak = 0.5
    static let graph: [String: Any] = [
        "backend": "openai",
        "model": "deepseek/deepseek-flash-nothink",
        "baseUrlEnv": "LITELLM_BASE_URL",
        "baseUrlSuffix": "/v1",
        "apiKeyEnv": "LITELLM_API_KEY",
        "maxConcurrency": 4,
        "timeoutSeconds": 900,
    ]
}

@MainActor
final class SettingsModel: ObservableObject {
    @Published var provider = Defaults.provider
    @Published var model = Defaults.model
    // Numbers are edited as text: a formatted field only commits on Enter or focus loss, and a
    // click on Save takes neither, so the old number would be saved.
    @Published var dims = String(Defaults.dims)
    @Published var queryPrefix = Defaults.prefix
    @Published var ollamaUrl = Defaults.ollamaUrl
    @Published var strong = String(Defaults.strong)
    @Published var weak = String(Defaults.weak)
    @Published var graphEnabled = true
    @Published var graphModel = Defaults.graph["model"] as! String
    @Published var baseUrl = ""
    @Published var apiKey = ""
    @Published var error: String?
    @Published var notice: String?
    @Published var loadFailed = false

    private var loadedIdentity = ""
    private var identity: String { provider == "transformers" ? model : "\(provider):\(model)" }

    func load() {
        notice = nil
        do {
            let c = try ConfigFile.load()
            provider = c["embeddingProvider"] as? String ?? Defaults.provider
            model = c["embeddingModel"] as? String ?? Defaults.model
            dims = String(c["embeddingDims"] as? Int ?? Defaults.dims)
            queryPrefix = c["embeddingQueryPrefix"] as? String ?? Defaults.prefix
            ollamaUrl = c["embeddingUrl"] as? String ?? Defaults.ollamaUrl
            strong = String(c["strongVectorSim"] as? Double ?? Defaults.strong)
            weak = String(c["weakVectorSim"] as? Double ?? Defaults.weak)
            graphEnabled = !(c["graph"] is NSNull)
            graphModel = (c["graph"] as? [String: Any])?["model"] as? String ?? Defaults.graph["model"] as! String
            loadedIdentity = identity
            loadFailed = false
            error = nil
        } catch {
            loadFailed = true
            self.error = "Cannot read \(ConfigFile.url.path): \(error.localizedDescription)"
        }
        baseUrl = Credentials.baseUrl
        apiKey = Credentials.apiKey
    }

    /// Starting values when switching provider. Thresholds stay as they are: they are only measured for bge models.
    func applyPreset(for provider: String) {
        switch provider {
        case "transformers": (model, dims, queryPrefix) = (Defaults.model, String(Defaults.dims), Defaults.prefix)
        case "ollama": (model, dims, queryPrefix) = ("bge-m3", "1024", "")
        case "openai": (model, dims, queryPrefix) = ("text-embedding-3-small", "1536", "")
        default: break
        }
    }

    func save() {
        notice = nil
        do {
            guard let dimsValue = Int(dims.trimmingCharacters(in: .whitespaces)), dimsValue > 0 else {
                throw CLIError(message: "Dimensions must be a positive whole number")
            }
            let strongValue = try similarity(strong, "Strong match similarity")
            let weakValue = try similarity(weak, "Weak match similarity")
            guard weakValue.doubleValue <= strongValue.doubleValue else {
                throw CLIError(message: "Weak match similarity must not be above strong match similarity")
            }
            var c = try ConfigFile.load()
            c["embeddingProvider"] = provider
            c["embeddingModel"] = model.trimmingCharacters(in: .whitespaces)
            c["embeddingDims"] = dimsValue
            c["embeddingQueryPrefix"] = queryPrefix
            c["strongVectorSim"] = strongValue
            c["weakVectorSim"] = weakValue
            if provider == "ollama" { c["embeddingUrl"] = ollamaUrl.trimmingCharacters(in: .whitespaces) }
            if !graphEnabled {
                c["graph"] = NSNull()
            } else if c["graph"] != nil || graphModel != Defaults.graph["model"] as! String {
                var g = c["graph"] as? [String: Any] ?? Defaults.graph
                g["model"] = graphModel.trimmingCharacters(in: .whitespaces)
                c["graph"] = g
            }
            try ConfigFile.save(c)
            // The graph appends /v1 itself, so the URL is stored without it.
            var url = baseUrl.trimmingCharacters(in: .whitespaces)
            while url.hasSuffix("/") { url.removeLast() }
            if url.hasSuffix("/v1") { url.removeLast(3) }
            baseUrl = url
            Credentials.baseUrl = url
            try Credentials.setApiKey(apiKey.trimmingCharacters(in: .whitespacesAndNewlines))
            error = nil
            if identity != loadedIdentity {
                notice = "Embeddings changed to \(identity). Prepare every source again; until then search skips vector mode for them."
            } else {
                notice = "Saved."
            }
            loadedIdentity = identity
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Accepts "0,65" as well as "0.65". A decimal number keeps the JSON as typed, not 0.65000000000000002.
    private func similarity(_ text: String, _ name: String) throws -> NSDecimalNumber {
        let normalized = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let value = Double(normalized), (0...1).contains(value) else {
            throw CLIError(message: "\(name) must be a number between 0 and 1")
        }
        return NSDecimalNumber(string: normalized, locale: Locale(identifier: "en_US_POSIX"))
    }
}

struct SettingsView: View {
    @StateObject private var settings = SettingsModel()

    var body: some View {
        Form {
            Section {
                TextField("Base URL", text: $settings.baseUrl, prompt: Text("https://litellm.example.com"))
                SecureField("API key", text: $settings.apiKey)
            } header: {
                Text("LiteLLM")
            } footer: {
                Text("Passed to docify as LITELLM_BASE_URL and LITELLM_API_KEY. The key is kept in the macOS Keychain, never in config.json. Empty fields fall back to the environment the app started with.")
                    .foregroundStyle(.secondary)
            }

            Section("Embeddings") {
                Picker("Provider", selection: $settings.provider) {
                    Text("Built-in").tag("transformers")
                    Text("Ollama").tag("ollama")
                    Text("LiteLLM / OpenAI API").tag("openai")
                }
                .onChange(of: settings.provider) { _, new in settings.applyPreset(for: new) }
                TextField("Model", text: $settings.model)
                TextField("Dimensions", text: $settings.dims)
                TextField("Query prefix", text: $settings.queryPrefix)
                if settings.provider == "ollama" {
                    TextField("Ollama URL", text: $settings.ollamaUrl)
                }
                TextField("Strong match similarity", text: $settings.strong)
                TextField("Weak match similarity", text: $settings.weak)
                if settings.provider == "openai" {
                    Text("Thresholds are only measured for bge models. Every search sends the query to the LiteLLM server.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Graph") {
                Toggle("Build a semantic graph when preparing", isOn: $settings.graphEnabled)
                TextField("Model", text: $settings.graphModel).disabled(!settings.graphEnabled)
            }

            if let error = settings.error {
                Text(error).foregroundStyle(.red).textSelection(.enabled)
            }
            if let notice = settings.notice {
                Text(notice).foregroundStyle(.orange)
            }
            HStack {
                Text(ConfigFile.url.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Spacer()
                Button("Revert") { settings.load() }
                Button("Save") { settings.save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(settings.loadFailed)
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear { settings.load() }
    }
}
