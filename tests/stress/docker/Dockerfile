# Stress-test image for `opera-browser-cli` process robustness.
#
# The suite kills daemons, MCP servers and browsers, and asserts on the OS
# process table, so it needs a machine where every matching process is a test
# subject: this container. `docs/specs/stress-test-system-plan.md` describes
# the scenarios; `tests/stress/helpers.ts` scopes every assertion to a
# session-unique process marker.
#
# The TypeScript build happens on the host (`npm run build`, which
# `scripts/stress-docker.js` runs for you) and the resulting `build/` is copied
# in. A cold `tsc` over the vendored devtools-frontend tree needs more heap than
# a container's cgroup-derived limit allows: inside a default colima VM it dies
# with "FATAL ERROR: Ineffective mark-compacts near heap limit" at ~1 GB. That
# is fine to avoid, because `build/` is self-contained - the published package
# ships `build/src` alone, `post-build.ts` has already written the devtools
# mocks, i18n stubs and issue descriptions into it, and the browser/CDP code is
# resolved from `node_modules`, which this image installs itself.
FROM node:24-slim

# `ps` drives every orphan assertion (procps), chromium is the browser under
# test, ca-certificates for the npm install below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        procps \
    && rm -rf /var/lib/apt/lists/*

# Both chromium variables matter: the daemon reads OPERA_CLI_EXECUTABLE_PATH,
# while `createCliEnv()` in tests/utils.ts prefers `puppeteer.executablePath()`
# and would otherwise point every spawned process at a Chrome the image never
# downloaded. PUPPETEER_EXECUTABLE_PATH is what makes that call return the
# image's copy.
ENV OPERA_CLI_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    OPERA_DEVTOOLS_NO_USAGE_STATISTICS=true \
    OPERA_DEVTOOLS_CRASH_ON_UNCAUGHT=true \
    OPERA_DEVTOOLS_NO_UPDATE_CHECKS=true

# The image exists to kill things it owns; the harness still refuses to signal
# anything that does not carry the session marker it minted.
ENV STRESS_ALLOW_PROCESS_KILLS=true

WORKDIR /app

# Runtime dependencies, keyed on the lockfile alone, so this expensive layer
# survives any source or build-output change. `--ignore-scripts` is deliberate:
# the install scripts in the tree are puppeteer's Chrome download (suppressed
# above), eslint's native resolver postinstall (eslint never runs here) and
# four no-op/banner/version-warning scripts.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Host-built output; `build/tests/**` carries the compiled stress suite.
COPY build/ ./build/

# Unprivileged owner of every process the suite spawns and signals. The image
# already ships one: `node` is UID 1000, so `useradd --uid 1000` collides.
USER node
ENV HOME=/tmp/stress-home \
    XDG_RUNTIME_DIR=/tmp/stress-run

# Create the runtime dirs at start rather than build time: the compose file
# mounts a tmpfs over /tmp, which would hide anything baked into the image.
#
# Run this image with an init (`docker run --init`, `init: true` in compose).
# The processes under test are detached daemons, so they are re-parented to pid
# 1 when the CLI that started them exits; without a reaping pid 1 they stay
# zombies, and `process.kill(pid, 0)` - the liveness check the suite and the
# product both use - reports a zombie as alive. Every assertion about a killed
# daemon would then be measuring the container, not the product.
#
# The timeout is generous on purpose: a red run spends a recovery timeout
# (5-15s) inside every failing scenario, so a 10-minute budget would kill the
# runner before it printed its report.
CMD ["sh", "-c", "mkdir -p \"$HOME\" \"$XDG_RUNTIME_DIR\" && exec node --import ./build/tests/setup.js --test --test-force-exit --test-timeout=1800000 build/tests/stress/runner.test.js"]