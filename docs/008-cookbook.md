# 008 Cookbook

How to build, run and test from a source checkout. It builds on [007 Architecture](007-architecture.md).

## Build and run

```sh
cd backend && bun install && bun run build        # compiles dist/neo-agent and dist/fixture-agy with --bytecode
cd app && flutter pub get && flutter build web --wasm --release --no-web-resources-cdn --csp --no-source-maps

backend/dist/neo-agent doctor                     # what this machine provides
backend/dist/neo-agent serve --web-dir app/build/web
# open http://127.0.0.1:3082/
```

The desktop app from source: `cd app && NEO_AGENT_BIN=../backend/dist/neo-agent flutter run -d macos` (or `windows`, `linux`). `NEO_AGENT_BIN` names the backend when it is not installed beside the app.

Bun 1.4 or later and Flutter 3.50 are needed. The web build's flags keep every resource on the server: nothing is fetched from another site, which the page's content security policy also enforces.

## Test and benchmark

```sh
cd backend
bun run check                                     # strict TypeScript typecheck
bun test                                          # everything that needs no runtime and no network
bun run bench                                     # hot-path latency and throughput benchmarks

cd ../app
flutter analyze && flutter test                   # host_io_test starts ../backend/dist/neo-agent when it is built
```

None of these call a model or WeChat. The application tests replace the runtime process with a scripted one: the Sessions, journals, effect queue, Engine and store are the real ones.

### In a browser

```sh
cd backend && bun run build
packaging/e2e/run-web-e2e.sh                      # needs the web build and playwright with Chromium
```

It starts the backend with the pure-TypeScript `fixture-agy` stand-in and Chromium, sends a message in the page, waits for the answer and the task, opens the settings, and fails on any console error or any request that leaves the server. Screenshots go to `.artifacts/web-e2e`. With `NEO_E2E_PACKAGE=<unpacked server package>` it tests that package instead, with the web app it bundles.

## A stand-in runtime

`backend/dist/fixture-agy` is a pure-TypeScript stand-in for `agy` that lists fixture models and drives Neo's orchestrator and worker MCP tools over the bridge folder:

```sh
NEO_AGY_BIN=backend/dist/fixture-agy \
  backend/dist/neo-agent serve --data-dir /tmp/neo-try --web-dir app/build/web
```

A stand-in runtime shows that the product's own parts work together. It says nothing about a real model's judgement; do not claim it does.

## What is not tested here

Real models, the real WeChat service, and anything on Windows or macOS beyond compiling: the backend is cross-compiled for those targets, and the installers and the desktop runners are built by the release workflow, not run by any test.
