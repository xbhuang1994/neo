# 008 Cookbook

How to build, run and test from a source checkout. It builds on [007 Architecture](007-architecture.md).

## Build and run

```sh
cd backend && cargo build -p neo-agent            # the backend: target/debug/neo-agent
cd app && flutter pub get && flutter build web --release --no-web-resources-cdn --csp --no-source-maps

backend/target/debug/neo-agent doctor            # what this machine provides
backend/target/debug/neo-agent serve --web-dir app/build/web
# open http://127.0.0.1:3082/
```

The desktop app from source: `cd app && NEO_AGENT_BIN=../backend/target/debug/neo-agent flutter run -d macos` (or `windows`, `linux`). `NEO_AGENT_BIN` names the backend when it is not installed beside the app.

Rust 1.89 or later and Flutter 3.50 are needed. The web build's flags keep every resource on the server: nothing is fetched from another site, which the page's content security policy also enforces.

## Test

```sh
cd backend
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                 # everything that needs no runtime and no network

cd ../app
flutter analyze && flutter test        # host_io_test starts ../backend/target/debug/neo-agent when it is built
```

None of these call a model or WeChat. The application tests replace the runtime process with a scripted one: the Sessions, journals, effect queue, Engine and store are the real ones.

### With the real runtime

The Antigravity CLI signs in to Google, so its opt-in tests run against real models: they need a signed-in `agy` (`NEO_AGY_BIN` when not on `PATH`) and the network (`NEO_AGY_MODEL` picks the model, by default `gemini-3.8-flash-low`). Both the protocol test and the product test use the pure-Rust `neo-agent agy-hook` relay:

```sh
cd backend
NEO_REAL_ANTIGRAVITY=1 cargo test -p neo-kernel --test antigravity_real -- --test-threads=1
NEO_REAL_ANTIGRAVITY=1 cargo test -p neo-agent --test real -- --test-threads=1
```

### In a browser

```sh
cargo build -p neo-agent -p neo-testkit      # in backend/
packaging/e2e/run-web-e2e.sh                 # needs the web build and the playwright package with its Chromium
```

It starts the backend with the pure-Rust `fixture-agy` stand-in and Chromium, sends a message in the page, waits for the answer and the task, opens the settings, and fails on any console error or any request that leaves the server. Screenshots go to `.artifacts/web-e2e`. With `NEO_E2E_PACKAGE=<unpacked server package>` it tests that package instead, with the web app it bundles.

## A stand-in runtime

`neo-testkit` builds `fixture-agy`, a pure-Rust stand-in for `agy` that lists fixture models and drives Neo's orchestrator and worker MCP tools over the bridge folder:

```sh
NEO_AGY_BIN=backend/target/debug/fixture-agy \
  backend/target/debug/neo-agent serve --data-dir /tmp/neo-try --web-dir app/build/web
```

A stand-in runtime shows that the product's own parts work together. It says nothing about a real model's judgement; do not claim it does.

## What is not tested here

Real models, the real WeChat service, and anything on Windows or macOS beyond compiling: the backend is checked for both targets, and the installers and the desktop runners are built by the release workflow, not run by any test.
