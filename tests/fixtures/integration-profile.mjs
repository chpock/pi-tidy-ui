// Read-only profile builder. It never imports extensions, installs packages, or writes settings.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

// Audited against the installed entry points, not npm metadata. A changed version
// must be reviewed again before the smoke test loads it with OS-level permissions.
const AUDITED = {
  "@victor-software-house/pi-curated-themes": "0.2.1",
  "@cortexkit/pi-magic-context": "0.44.4",
  "@cortexkit/aft-pi": "0.58.2",
  "pi-hide-providers": "0.1.22",
  "pi-web-access": "0.35.0",
  "@tintinweb/pi-subagents": "0.19.0",
  "@tintinweb/pi-tasks": "0.9.0",
  "@juicesharp/rpiv-ask-user-question": "2.12.0",
  "@raidou/pi-notify": "0.7.4",
  "@pedro_klein/pi-caffeinate": "0.2.0",
  "@pedro_klein/pi-adhd": "0.2.0",
  "pi-context-view": "0.6.0",
  "pi-powerline-footer": "0.19.1",
};

const EXCLUDED = {
  "@cortexkit/aft-pi":
    "The factory eagerly starts the persistent Rust bridge and can download a binary, ONNX runtime, or LSP servers. indexes.semantic=false and lsp.auto_install=false do not disable eager bridge startup. The only startup bypass is MAGIC_CONTEXT_PI_SUBAGENT, a delegated-worker identity, not a general offline switch; this primary-session test does not impersonate a worker. AFT loader/renderer coexistence is therefore NOT covered.",
  "@pedro_klein/pi-caffeinate":
    "agent_start unconditionally spawns caffeinate or systemd-inhibit/sleep infinity. The installed extension has no supported disable setting or flag; even the offline fixture provider emits agent_start.",
};

/**
 * Return data for a real-CLI smoke test using the user's installed package sources.
 *
 * The caller must supply fresh, test-owned homeDir, agentDir and workDir, write
 * settings to agentDir/settings.json and materialize configFiles BEFORE starting
 * Pi, and pass env as the COMPLETE child environment (do not merge process.env).
 * This helper itself writes nothing. Local source directories remain read-only.
 * The caller owns the offline provider, PTY, tool-execution guard and cleanup.
 * PI_OFFLINE suppresses host automatic network activity, NOT extension tool calls.
 * Never execute Agent/TaskExecute, web search/fetch, /btw, /note <text>, or model
 * commands in this profile. Use harmless real local tools with a tool-call allowlist
 * to exercise the installed renderers; their mere registration is not rendering.
 */
export function getInstalledIntegrationProfile({
  homeDir,
  agentDir,
  workDir,
  sourceAgentDir = process.env.TIDY_UI_SOURCE_AGENT_DIR || join(homedir(), ".pi", "agent"),
  provider = "tidy-ui-offline",
  model = "scripted",
} = {}) {
  for (const [name, path] of Object.entries({ homeDir, agentDir, workDir, sourceAgentDir })) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  }
  const source = resolve(sourceAgentDir);
  for (const path of [homeDir, agentDir, workDir]) {
    const isolated = resolve(path);
    if (isolated === source || isolated.startsWith(`${source}/`) || source.startsWith(`${isolated}/`)) {
      throw new Error("Integration directories must not overlap the user's source agent directory");
    }
  }
  const settingsPath = join(source, "settings.json");
  const declared = JSON.parse(readFileSync(settingsPath, "utf8")).packages ?? [];
  const inventory = [];
  const exclusions = [];
  const packages = [];
  for (const declaration of declared) {
    const spec = typeof declaration === "string" ? declaration : declaration.source;
    const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(spec ?? "");
    if (!match) {
      exclusions.push({ source: spec, reason: "Not an audited installed npm package source; no installation or remote resolution is allowed." });
      continue;
    }
    const name = match[1];
    const directory = join(source, "npm", "node_modules", name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath) || !statSync(directory).isDirectory()) {
      exclusions.push({ name, reason: "No existing local installed package directory/manifest." });
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    inventory.push({ name, version: manifest.version, source: directory, resources: manifest.pi ?? {} });
    const reason = manifest.name !== name ? "Installed manifest name does not match the configured package."
      : AUDITED[name] !== manifest.version ? "Installed version has not been reviewed for startup side effects."
      : EXCLUDED[name];
    if (reason) {
      exclusions.push({ name, version: manifest.version, source: directory, reason });
      continue;
    }
    // Load the real manifest's extensions/themes, not copied entry points.
    // Skill/prompt content is intentionally irrelevant to this renderer smoke test.
    packages.push({ source: directory, skills: [], prompts: [] });
  }

  const includedNames = new Set(inventory.filter((entry) => packages.some((pkg) => pkg.source === entry.source))
    .map((entry) => entry.name));
  const configHome = join(homeDir, ".config");
  const dataHome = join(homeDir, ".local", "share");
  const settings = {
    packages,
    defaultProvider: provider,
    defaultModel: model,
    enabledModels: [`${provider}/${model}`],
    defaultThinkingLevel: "off",
    defaultProjectTrust: "never",
    extensions: ["-builtin:mcp", "-builtin:llama.cpp"],
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    quietStartup: true,
    theme: includedNames.has("@victor-software-house/pi-curated-themes") ? "gruvbox-dark-hard" : "dark",
    tuiMode: "fullscreen",
    terminal: { showTerminalProgress: false, showImages: false },
    // notifyReal checks enabled; the other controls also suppress focus/tmux effects.
    piNotify: { enabled: false, finished: false, notifyTools: [], onlyNotifyWhenUnfocused: false, tmuxSymbol: "" },
    powerline: { preset: "default", placement: "below", welcome: false, autoFollowUp: false, disabledSegments: ["git"], cost: { currency: "USD" } },
    // No secondary model request for generated working-status text.
    workingVibe: "off",
  };
  const jsonFile = (path, value) => ({ path, content: `${JSON.stringify(value, null, 2)}\n` });
  const configFiles = [
    jsonFile(join(agentDir, "subagents.json"), {
      schedulingEnabled: false,
      workflowsEnabled: false,
      agentMentions: "off",
      rememberAgents: false,
      outputTranscript: false,
      worktreeIsolation: false,
    }),
    jsonFile(join(agentDir, "web-search.json"), {
      workflow: "none",
      autoOpenBrowser: false,
      allowBrowserCookies: false,
      // Keep the real tools and renderers registered. No tools run at startup.
      toolActivation: "eager",
      commands: { websearch: { enabled: false }, curator: { enabled: false }, search: { enabled: false }, "google-account": { enabled: false } },
      fetch: { defaultMode: "raw", allowedModes: ["raw"] },
    }),
    // MC's config loader honors XDG_CONFIG_HOME; these controls are in the
    // installed schema. No historian/dreamer/provider/account configuration is copied.
    jsonFile(join(configHome, "cortexkit", "magic-context.jsonc"), {
      enabled: true,
      auto_update: false,
      compaction: { enabled: false },
      historian: { disable: true },
      dreamer: { disable: true },
      embedding: { provider: "off" },
      shadow_embedding: { enabled: false },
      memory: { enabled: true, auto_promote: false, auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
      system_prompt_injection: { enabled: false },
      todowrite: { enabled: false },
      debug_rpc: false,
      pi: { subagent_extensions: [] },
    }),
  ];
  const env = {
    // Deliberately do not carry API keys, OAuth tokens, proxy configuration,
    // NODE_OPTIONS, parent subagent markers, TMUX or display/notification sockets.
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    SHELL: "/bin/bash",
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_STATE_HOME: join(homeDir, ".local", "state"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    // Documented extension storage mode: tools stay registered, store is in memory.
    PI_TASKS: "off",
  };
  return {
    packages,
    inventory,
    exclusions,
    settings,
    env,
    configFiles,
    workDir,
    limitations: [
      "AFT and keep-awake are excluded for the documented reasons; this is not the full user runtime.",
      "Magic Context keeps real ctx_search/ctx_memory/ctx_note/ctx_expand registrations and local SQLite storage; compaction, embeddings, historian, dreamer and remote/subc lanes are disabled. ctx_reduce is intentionally absent.",
      "When pi-notify is included, desktop notifications are disabled but it still writes dashboard state inside the isolated agent directory.",
      "Commands that can request a model or run networked tools are not exercised. Registration/loader checks alone do not prove renderer execution; the harness must explicitly exercise safe third-party renderers.",
      "Fresh HOME is required as well as PI_CODING_AGENT_DIR: pi-adhd and legacy config fallbacks use homedir() directly.",
    ],
  };
}
