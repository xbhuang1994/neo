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

### With the real runtimes

These start the real `claude` and `omp` programs against a model endpoint on a loopback port that the test scripts. They need the runtimes installed, no account and no network, and take a few minutes:

```sh
cd backend
NEO_REAL_KERNELS=1 cargo test -p neo-kernel --test claude_real --test omp_real -- --test-threads=1
NEO_REAL_KERNELS=1 cargo test -p neo-agent --test real -- --test-threads=1
```

The first pair exercises each protocol: a host tool, a refused built-in tool, resuming after a restart, a notice joining the next turn, a background job and its cancellation. The second drives the whole product as a process: a chat message over HTTP becomes a Ticket, a worker writes a file with its shell, and the result comes back. `NEO_CLAUDE_BIN` and `NEO_OMP_BIN` name the programs when they are not on `PATH`.

### In a browser

```sh
cargo build -p neo-agent -p neo-testkit      # in backend/
packaging/e2e/run-web-e2e.sh                 # needs the web build, claude, and the playwright package with its Chromium
```

It starts a scripted model, the backend with the real `claude` runtime and Chromium, sends a message in the page, waits for the answer and the task, opens the settings, and fails on any console error or any request that leaves the server. Screenshots go to `.artifacts/web-e2e`. With `NEO_E2E_PACKAGE=<unpacked server package>` it tests that package instead, with the runtime and web app it bundles.

## A scripted model

`neo-testkit` has an Anthropic Messages endpoint and an OpenAI chat-completions endpoint whose every answer a closure gives, as text or tool calls. `ticket_flow` is one such script: an orchestrator that accepts each request and sends each result, and a worker that writes a file and reports. `fixture-model anthropic|openai` runs it as a program and prints its address, for trying the product by hand:

```sh
backend/target/debug/fixture-model anthropic &        # prints http://127.0.0.1:<port>
ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=x \
  backend/target/debug/neo-agent serve --data-dir /tmp/neo-try --web-dir app/build/web
```

A scripted endpoint shows that the product's own parts work together. It says nothing about a real model's judgement; do not claim it does.

## What is not tested here

Real models, the real WeChat service, and anything on Windows or macOS beyond compiling: the backend is checked for both targets, and the installers and the desktop runners are built by the release workflow, not run by any test.
