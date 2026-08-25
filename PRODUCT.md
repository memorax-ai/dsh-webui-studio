# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are developers who build, adapt, and debug DeepSeek Harness WebUI plugins and Harmony patches. They need to understand the live WebUI, work against the same plugin graph their users run, and turn changes into distributable plugin-owned patches instead of editing installed DSH sources.

The wider product context also includes DSH users who install plugins and manage Harmony patch order. Studio does not replace their normal DSH workflow; it helps plugin developers produce changes that remain compatible with that workflow.

## Product Purpose

`dsh-webui-studio` is a local development environment for creating and modifying DSH WebUI plugins as isolated Draft layers. It combines an interactive real WebUI preview, DOM and React inspection, source editing, build and Harmony activation, readiness checks, and DSH-hosted Agent assistance without loading in-progress plugin code into the user's stable DSH Host.

Success means a developer can start from a new package or an existing local plugin folder, test the Draft against a representative DSH profile, trace previewed UI back to relevant source, make a plugin-shaped change, and verify the activated result while the stable DSH environment remains usable.

## Positioning

Studio is not a generic page builder and does not treat the rendered WebUI as freely editable application source. It treats each change as a plugin or Harmony patch layered over an existing DSH WebUI whose components and data may come from multiple plugins.

Its defining mechanism is a stable DSH control plane paired with one isolated Git worktree, child `DSH_HOME`, dependency tree, Harmony state, and child Preview Host per Draft. This lets multiple Drafts run concurrently and preserves the real DSH plugin and Patch semantics during development.

## Operating Context

Studio is served by a stable local `dsh web` Host at `/studio`. The stable Host owns the Studio interface, Draft registry, and Agent sessions. Studio can inspect that Host's current WebUI directly in read-only mode. Each running Draft is previewed by a separate child `dsh web` Host inside Studio's main iframe, which can expand to fullscreen.

Developers may create a minimal new Web Client plugin or import an existing local plugin folder as an isolated snapshot. A new plugin remains Studio-only by default; creation may record an optional absolute destination for a new or empty local folder, but Studio does not touch that folder until the user explicitly saves the project there. Later explicit saves synchronize the Studio snapshot without deleting destination-only files. Studio validates the Web Client manifest, excludes `.git` and `node_modules`, rejects symbolic links, and commits the copy into a Studio-owned Git repository without modifying the source folder. Draft repositories, worktrees, runtime homes, and registry records live under the stable Harness home's `studio` directory.

The normal loop is to start a Draft Preview Host, interact with the WebUI in Browse mode, inspect an element when source context is needed, edit the selected Draft package directly or through the stable DSH Agent, run the package's build, apply the result through the child Harmony transaction, and confirm the live Client graph revision.

## Capabilities and Constraints

- Every Draft owns an isolated worktree, child Harness home, `profiles/web`, dependency installation, Harmony state, and Preview Host. Multiple Draft Preview Hosts may run at once.
- A Draft snapshots either the main `web` profile or another local profile selected by absolute folder path. Relative `link:` dependencies are resolved against the selected source profile, and the Draft package is linked to its worktree. Studio never modifies the source profile and never silently falls back to the main profile.
- Browse mode preserves normal WebUI interaction. Inspect mode captures a redacted DOM snapshot and provides best-effort React component, owner, and source mapping.
- The Source panel edits UTF-8 files inside the selected Draft package. Builds use the package's fixed `scripts.build`; activation completes only after Preview confirms the new live Client graph revision.
- Readiness inspection covers package identity, DSH exports, built and Patch artifacts, dependencies, Harmony state and order, target version bounds, and differential Source Patch providers. Package inspection uses `npm pack --dry-run --json --ignore-scripts` through the managed DSH subprocess runtime.
- Agent sessions stay in the stable DSH and retain their model, history, identity, and session configuration. Studio can create a session or temporarily attach an existing ordinary session. Entering Studio mode adds one scoped tool set, runtime skill, system instruction, and target context; leaving removes that scope and restores ordinary DSH composition. Current-instance mode exposes only read-only tools for the live DOM selection, Harmony profile and targets, installed dependency source, and Preview status. Draft mode additionally exposes Draft files, exact patches, build, and reload. The Agent panel answers pending one-shot tool approvals, structured questions, and plan reviews through the Host interaction protocol. Preview-derived DOM, source, Patch, and comment data is untrusted evidence rather than Agent instruction. The child Preview Host does not own the Agent control plane.
- The stable Host exposes the same current-instance inspection set to out-of-process Agents through a stateless Streamable HTTP MCP endpoint at `/studio/mcp`. It remains loopback-only and contains no Draft write, build, reload, or profile mutation tools; the external Agent owns edits in its own workspace. Harmony and dependency inspection are Host-native, while live DOM selection is supplied by an open current-instance Studio Preview.
- The official WebUI continues to use its own-origin `/api` and WebSockets. Studio does not proxy WebUI traffic or introduce a second backend address.
- Draft labels are persisted independently from npm package names. Studio stores ordered open Draft tabs and the active Draft in `$DSH_HOME/studio/workspace.json`; closing every tab remains an explicit empty workspace across Host restarts, and closing a tab never stops or deletes its Draft. Unsaved Source changes block tab switching and closing until saved.
- Plugin Management reads the active Draft Preview's public Harmony profile and inspection. Provider controls stay in the sidebar; the wider Patch ordering workspace stages Patch order and enablement, then commits the Draft profile through one transactional hot reload. The stable Studio Host is never modified.
- Element CSS editing persists generated, subtree-scoped CSS beside the registered Element source and restores the editable rule model after a Studio reload.
- Automatic CSS Patch creation analyzes named Component declarations, presents every match for confirmation, and emits a Component decorator plus Draft client export without touching existing JSX call sites or Props.
- Stopping a Draft terminates its child Host but preserves its repository, worktree, profile, and registry record. Closing the Studio page does not delete Drafts.
- A Draft package must be a buildable DSH Web Client package with `dsh.client.platform: "web"`, the required package exports, and a non-empty `scripts.build`.
- Studio is a local development surface. Its Host plugin is disabled when `dsh web` is not bound to `127.0.0.1`.

## Brand Commitments

The product name is `dsh-webui-studio`, displayed as DeepSeek WebUI Studio inside DSH. Its voice is native, precise, and calm: terminology should follow DSH and Harmony concepts instead of introducing a separate low-code vocabulary.

Studio is a focused developer environment rather than a decorative mod manager. It should keep Draft state, isolation boundaries, build consequences, and Preview status legible without turning primary workflows into raw diagnostic output. Motion should be purposeful rather than flashy.

## Evidence on Hand

- The runnable Studio Host plugin and browser application live under `src`.
- The implemented architecture and development contract are documented in `README.md`.
- Harmony runtime behavior and public terminology are documented in the repository root `README.md`.
- React-aware patch factories available to Draft plugin authors are documented by the upstream `dsh-harmony-react` package.
- Existing Harmony icon assets are available at `assets/harmony-icon.png` and `assets/harmony-icon-mono.png`; `assets/webui-banner-example.jpg` is a WebUI integration example, not product proof.
- There are no confirmed customer testimonials, usage benchmarks, pricing claims, or deployment claims. Future product or marketing work must not fabricate them.

## Product Principles

- Preserve the stable DSH environment: unfinished Draft code belongs in isolated Preview Hosts.
- Express changes as distributable plugin and Harmony artifacts, not arbitrary edits to installed WebUI sources.
- Preview the real system: retain DSH origin, plugin graph, data, and interaction semantics during testing.
- Make state transitions explicit: distinguish built, preview-pending, active, stopped, and preserved Draft state.
- Keep the development loop layered and direct: inspect, edit, build, activate, and verify without hiding the underlying files or Patch behavior.

## Accessibility & Inclusion

Follow the host WebUI accessibility baseline. Essential Studio actions need keyboard-accessible controls and visible focus; status and validation must not rely on color alone; reduced-motion preferences and the host theme's contrast-tested tokens must be respected.
