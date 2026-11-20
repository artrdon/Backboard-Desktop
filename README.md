# DQuant Lab: the AI IDE for MQL4 and MQL5

**AI IDE for MQL4 and MQL5.**

DQuant Lab is an AI-powered development environment designed for MQL4 and MQL5 developers. Build, edit, debug, and develop algorithmic trading systems with AI assistance.

DQuant Lab is a desktop IDE built on Code - OSS (the open-source core of VS Code). Every chat session is bound to one MetaTrader generation - MQL4 or MQL5 - so the agent, its instructions, and its documentation lookup never mix the two APIs. Sessions keep their own language, so you can work on an EA for MetaTrader 4 in one session and an indicator for MetaTrader 5 in the next.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-informational)](#getting-started)
[![Built on Code - OSS](https://img.shields.io/badge/built%20on-Code%20--%20OSS-007ACC)](https://github.com/microsoft/vscode)

[Getting started](#getting-started) - [Features](#features) - [Development](#development) - [License](#license)

## What it does

Use the welcome screen to pick a language and a project name. DQuant Lab creates a session whose agent profile, system instructions and reference lookups are pinned to that language:

| Language | Target | What the agent works with |
| --- | --- | --- |
| **MQL4** | MetaTrader 4 | `.mq4` / `.mqh`, Expert Advisors, custom indicators, scripts. MQL4 order model and event handlers. |
| **MQL5** | MetaTrader 5 | `.mq5` / `.mqh`, Expert Advisors, custom indicators, scripts, services. MQL5 trading API, `OnCalculate`, `CTrade`, events. |

A session created for MQL5 stays MQL5 when you switch back to it. Sessions created before the language picker existed keep working unchanged.

## Features

- **Language-bound sessions:** MQL4 or MQL5 chosen once per session, restored with the session, and never shared with other sessions.
- **Reference-first agent instructions:** the agent is told to check the official MQL4/MQL5 reference (docs.mql4.com, mql5.com/en/docs) before writing API calls, and not to invent functions, constants or signatures.
- **AI coding agents:** agents read, write and run code in your project, with checkpoints you can rewind and a review panel for every change.
- **Bring your own key (BYOK):** OpenAI, Anthropic, Google Gemini, xAI Grok, OpenRouter or any OpenAI-compatible endpoint, stored in your OS keychain.
- **Bring your own subscription (BYOS):** run agents on your Claude Pro/Max or ChatGPT Plus/Pro plan.
- **Hosted models:** Claude, GPT, Gemini, Kimi, DeepSeek, Qwen, GLM and more from one model picker.
- **Parallel agent sessions:** organize work by project, branch and session; run agents side by side in isolated git worktrees.
- **A real editor:** the Code - OSS editing experience with files, terminals, debugging and extensions, in the same window.

Agent integrations require the credentials or accounts for the services you choose. Access to hosted services is separate from this repository's source-code license.

### Security and credentials

- **Hosted-model API key:** stored in `~/.backboard_ide/config.json`. The agent never reads it
  from disk - the host injects it as `BACKBOARD_API_KEY` / `BACKBOARD_API_URL` into the
  spawned `cli-ts` environment, and `cli-ts` checks `process.env` before touching any file.
- **BYOK for OpenAI, Anthropic, Google, xAI and OpenRouter:** keys are added on the API Keys
  page (account menu, or "DQuant Lab: API Keys" in the command palette). The Electron main
  process is the single owner: it validates a key through the runtime, then saves it as an
  encrypted `secret://` entry in application storage - the same keychain-backed store
  `ISecretStorageService` uses - and activates it in the agent host. The host hands the key
  set to each `cli-ts` serve process over stdin, never through argv, the environment or a file.
- **Key-billed models** appear in the model picker as their own sections next to the
  hosted and subscription models. The selected model is the billing route: adding or removing
  a key never silently changes what an existing session bills to.
- Credentials can be overridden via environment variables for CI or local development.
  Provider keys deliberately cannot.

### Telemetry

- **No analytics keys ship in this repository.** Product analytics (PostHog) and
  ad-conversion reporting stay off unless a build supplies a key: release builds stamp
  `backboardAnalytics.posthogKey` into `backboard/product.json` at build time, and builds
  from source send nothing. When enabled, analytics follow the `telemetry.telemetryLevel`
  setting.
- **Computer use** runs the bundled [cua-driver](backboard/cua-driver/README.md). Its usage
  telemetry key is also supplied at build time (`CUA_DRIVER_POSTHOG_KEY`), so a source build
  sends none. In builds that include it, set `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, or
  `"telemetry_enabled": false` in `~/.cua-driver/config.json`, to turn it off.

## Getting started

### Run from source on macOS

Install these prerequisites:

- **Git** to clone the repository.
- **Node.js 24.15.0**, pinned in [`.nvmrc`](backboard/.nvmrc), with npm.
- **Bun** to run the TypeScript agent runtime in a development checkout.
- **Xcode Command Line Tools** for native dependencies.

```bash
npm run dev-setup   # from backboard/, once per checkout
npm run dev         # build, launch and watch
npm run dev-logs    # follow the output
```

The launcher downloads Electron and prepares built-in extensions. For UI changes, wait for the watcher and run **Developer: Reload Window** in the app. Restart the app after main-process changes.

### Run from source on Linux

Install Node.js 24.15.0, Bun, and the Electron build dependencies (`build-essential`, `pkg-config`, `python3`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`, `libgtk-3-dev`, `libnss3`, `libasound2`):

```bash
cd backboard
npm ci
npm run electron
npm run watch
./scripts/code.sh
```

### Connect a model provider

Open the app and complete the sign-in or provider setup for your chosen integration. For local development, you can supply the hosted-model key through environment variables in the launch terminal:

```bash
export BACKBOARD_API_KEY="your-api-key"
./scripts/code.sh
```

The IDE passes resolved credentials to the agent process. The standalone CLI also supports environment variables; see the [CLI runtime guide](backboard/cli-ts/README.md) for its configuration and provider options.

## Development

Run these commands from `backboard/`. The `dev.sh` supervisor is for macOS; Windows and Linux use `npm run watch` with the launch commands above.

| Command | Purpose |
| --- | --- |
| `./scripts/dev.sh` | Set up, build, launch and watch for changes. |
| `./scripts/dev.sh doctor` | Check the local toolchain. |
| `./scripts/dev.sh setup` | Install editor dependencies and download Electron. |
| `./scripts/dev.sh logs` | Follow build output. |
| `./scripts/dev.sh status` | Inspect the development processes. |
| `./scripts/dev.sh stop` | Stop the app and watcher. |
| `npm run watch` | Watch client and extension builds on any platform. |
| `npm run typecheck-client` | Type-check the main application sources. |

After changing renderer code, wait for the watcher to finish and run **Developer: Reload Window**. See the [development guide](backboard/DEV_ENVIRONMENT.md) for the full workflow and troubleshooting.

To work on the agent runtime separately:

```bash
cd backboard/cli-ts
bun install
bun run dev
bun run validate
```

### DQuant Lab sources

The MQL4/MQL5 integration lives in dedicated modules on top of the existing session and agent-host architecture:

| Path | Contents |
| --- | --- |
| [`backboard/src/vs/sessions/contrib/dquant/`](backboard/src/vs/sessions/contrib/dquant/) | Welcome screen (language + project name) and its styling. |
| [`backboard/src/vs/sessions/services/dquant/`](backboard/src/vs/sessions/services/dquant/) | Per-session language profile service. |
| [`backboard/src/vs/workbench/contrib/dquant/prompts/`](backboard/src/vs/workbench/contrib/dquant/prompts/) | MQL4 and MQL5 agent instructions. |
| [`backboard/src/vs/platform/agentHost/node/dquant/`](backboard/src/vs/platform/agentHost/node/dquant/) | Session context injected into the agent system prompt. |

### Re-branding the app icons

Every platform icon is generated from one square PNG (1024x1024 recommended, transparent background):

```bash
scripts/rebrand-icons.sh path/to/logo-1024.png                    # platform icons only
scripts/rebrand-icons.sh path/to/logo-1024.png --dock             # + macOS Dock variants
scripts/rebrand-icons.sh path/to/logo-1024.png --dock --in-app    # + the in-app SVG logos
```

The script rewrites the `backboard/resources/{darwin,linux,win32,server}` assets, rebuilds `code.icns` (via `iconutil`, `png2icns` or a bundled Python writer), and verifies every size it produced. With `--in-app` it also rewrites the UI logos under `backboard/src/**/media` as 256px PNGs embedded in SVG, using the colour each surface expects (black silhouettes for the mark and title icons, `#D9D9D9` for the dark-theme sessions logo, brand blue for the blue mark), and refreshes the matching `backboard/out` copies so a running dev build picks them up after a window reload.

### Repository layout

| Path | Contents |
| --- | --- |
| [`backboard/`](backboard/) | The Code - OSS fork, application source, built-in extensions and build tooling. |
| [`backboard/src/vs/sessions/`](backboard/src/vs/sessions/) | Agent workspace UI, session navigation and chat surfaces. |
| [`backboard/src/vs/platform/agentHost/`](backboard/src/vs/platform/agentHost/) | Agent process management and provider integrations. |
| [`backboard/cli-ts/`](backboard/cli-ts/) | The Bun/TypeScript agent runtime, tools, skills and MCP support. |
| [`scripts/`](scripts/) | Release and packaging scripts. |
| [`docs/`](docs/) | Project documentation and technical references. |

## Building a release

| Target | Command |
| --- | --- |
| Linux x64 `.deb` | `cd backboard && npm run electron && npm run gulp -- vscode-linux-x64 vscode-linux-x64-prepare-deb vscode-linux-x64-build-deb` |
| Linux release (container) | `scripts/linux-release/build-in-container.sh` |
| Windows / macOS | See [Windows packaging](scripts/windows-release/README.md) and [macOS installer assets](scripts/dmg-assets/README.md). |

The Linux package is `dquant-lab` and installs `/usr/share/dquant-lab/dquant-lab`, `dquant-lab.desktop` and the `dquant-lab` icon name. See [Linux packaging](scripts/linux-release/README.md).

## Documentation

- [Remote agent locations (EC2)](docs/cloud-agent-locations.md)
- [Development environment](backboard/DEV_ENVIRONMENT.md)
- [CLI runtime and configuration](backboard/cli-ts/README.md)
- [Sessions architecture and layering](backboard/src/vs/sessions/LAYERS.md)
- [Session layout](backboard/src/vs/sessions/LAYOUT.md)
- [Linux packaging](scripts/linux-release/README.md)

## Contributing

Bug reports, documentation improvements and code contributions are welcome.

1. Search existing issues before filing a new one. Include your operating system, app version or commit, reproduction steps and expected behavior.
2. For substantial changes, open an issue first to discuss the approach.
3. Keep each pull request focused on one change and describe what you tested.
4. Follow the surrounding code style and [layering rules](backboard/src/vs/sessions/LAYERS.md).

The inherited [VS Code contribution guide](backboard/CONTRIBUTING.md) documents upstream practices and links to Microsoft's project; use those channels for issues or contributions that belong upstream.

## Credits and lineage

**Thank you to Microsoft and the Visual Studio Code community.** DQuant Lab builds on Code - OSS, the MIT-licensed open-source core of Visual Studio Code. The upstream [Code - OSS repository](https://github.com/microsoft/vscode) is the foundation of this project, and the editor, workbench, terminal, debugger and extension infrastructure come from that work.

DQuant Lab started from the MIT-licensed **Backboard Desktop** project by Espri.ai and the Backboard Desktop contributors. The agent runtime, session architecture and update infrastructure in this repository originate there; they keep their original copyright and license notices.

We also thank the maintainers and contributors of the open-source dependencies used throughout the app. See [Third-party notices](backboard/ThirdPartyNotices.txt) and individual source files for acknowledgments and license information.

## License

Released under the [MIT License](LICENSE).

The repository retains Microsoft's upstream copyright and license notice in [backboard/LICENSE.txt](backboard/LICENSE.txt), and the original Backboard Desktop notices in the files that came from that project. Third-party components retain their respective licenses and notices; see [ThirdPartyNotices.txt](backboard/ThirdPartyNotices.txt).
