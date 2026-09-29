# Host engineering entry

Before changing installation, execution, cancellation, restart recovery, phone sync
or upgrades, read [HOST-LIFECYCLE.md](HOST-LIFECYCLE.md), then the relevant owner,
focused tests and [architecture](docs/architecture.md). Apply the contract to new
capabilities as well as repairs. Keep facts, intended semantics and proof separate.
Preserve unrelated work. This repository is the sole Host source authority. Aru
pins this repository; update that pin instead of editing a native Host copy.

Edit runtime code under `src/`. Root runtime `.mjs` files are generated payloads;
`tools/build-runtime.mjs` and `tools/runtime-entries.json` own their generation.
Keep root deployment names for released fixed-list upgraders. Run
`node tools/build-runtime.mjs` after source changes and `--check` before commit.
Root bundle/build scripts, installers and Console sources remain handwritten.
