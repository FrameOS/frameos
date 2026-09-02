# syntax=docker/dockerfile:1.6

ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG ESP_IDF_VERSION=v5.5.4
# Comma-separated list passed to ESP-IDF install.sh; every chip the embedded
# firmware builds for (ESP32-S3 boards render locally, ESP32-C3 boards are
# thin clients).
ARG ESP_IDF_TARGET=esp32s3,esp32c3

FROM ${PYTHON_IMAGE} AS nim-toolchain

ARG NIM_VERSION=2.2.4
ARG FRAMEOS_ARCHIVE_BASE_URL=https://archive.frameos.net

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The digest list is the trust anchor for the compiler, not the CDN: an
# archive whose sha256 is not on it is refused before extraction. Recipe
# for a new Nim at the top of that file.
COPY .github/nim-prebuilt.sha256 /tmp/nim-prebuilt.sha256

RUN set -eux; \
    . /etc/os-release; \
    distro="${ID}"; \
    release="${VERSION_CODENAME:-${VERSION_ID:-}}"; \
    case "${distro}" in \
      raspios|raspbian) distro="debian" ;; \
      debian|ubuntu) ;; \
      *) echo "Unsupported prebuilt Nim distro: ${distro}" >&2; exit 1 ;; \
    esac; \
    case "${distro}" in \
      debian) \
        case "${release}" in \
          bullseye|bookworm|trixie) ;; \
          *) echo "Unsupported prebuilt Nim release: ${distro}-${release}" >&2; exit 1 ;; \
        esac ;; \
      ubuntu) \
        case "${VERSION_ID}" in \
          22.04|24.04|26.04) release="${VERSION_ID}" ;; \
          *) echo "Unsupported prebuilt Nim release: ${distro}-${VERSION_ID}" >&2; exit 1 ;; \
        esac ;; \
    esac; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64|arm64|armhf) ;; \
      *) echo "Unsupported prebuilt Nim architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    nim_target="${distro}-${release}-${arch}"; \
    nim_archive="${nim_target}/nim-${NIM_VERSION}.tar.gz"; \
    expected="$(grep -E "^[0-9a-f]{64}  ${nim_archive}\$" /tmp/nim-prebuilt.sha256 | cut -d' ' -f1 || true)"; \
    if [ -z "${expected}" ]; then echo "No sha256 recorded for ${nim_archive} in .github/nim-prebuilt.sha256" >&2; exit 1; fi; \
    mkdir -p /opt/nim /tmp/nim-download; \
    echo "${nim_target}" > /opt/nim/.frameos-prebuilt-target; \
    curl -fsSL "${FRAMEOS_ARCHIVE_BASE_URL}/prebuilt-deps/${nim_archive}" -o /tmp/nim.tar.gz; \
    echo "${expected}  /tmp/nim.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/nim.tar.gz -C /tmp/nim-download; \
    rm -rf "/tmp/nim-download/nim-${NIM_VERSION}/nim/bin"; \
    cp -a "/tmp/nim-download/nim-${NIM_VERSION}/bin" /opt/nim/bin; \
    cp -a "/tmp/nim-download/nim-${NIM_VERSION}/nim/." /opt/nim/; \
    rm -rf /tmp/nim-download /tmp/nim.tar.gz /tmp/nim-prebuilt.sha256

ENV PATH="/opt/nim/bin:${PATH}"

RUN nim --version && nimble --version

FROM ${PYTHON_IMAGE} AS esp-idf-toolchain

ARG ESP_IDF_VERSION
ARG ESP_IDF_TARGET

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive
ENV IDF_PATH=/opt/esp/esp-idf
ENV IDF_TOOLS_PATH=/opt/esp/idf-tools

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bison \
      build-essential \
      ca-certificates \
      ccache \
      cmake \
      dfu-util \
      flex \
      git \
      gperf \
      libgcrypt20 \
      libffi-dev \
      libglib2.0-0 \
      libpixman-1-0 \
      libsdl2-2.0-0 \
      libssl-dev \
      libslirp0 \
      libusb-1.0-0 \
      ninja-build \
      python3 \
      python3-pip \
      python3-setuptools \
      python3-venv \
      wget \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# This stage intentionally builds for the target Docker platform. Multi-arch
# images get matching native Linux ESP-IDF host tools in each runtime image.
RUN set -eux; \
    mkdir -p "$(dirname "${IDF_PATH}")" "${IDF_TOOLS_PATH}"; \
    git clone --depth 1 --branch "${ESP_IDF_VERSION}" --recursive --shallow-submodules \
      https://github.com/espressif/esp-idf.git "${IDF_PATH}"; \
    "${IDF_PATH}/install.sh" "${ESP_IDF_TARGET}"; \
    python "${IDF_PATH}/tools/idf_tools.py" install qemu-xtensa; \
    . "${IDF_PATH}/export.sh" >/dev/null 2>&1; \
    idf.py --version; \
    qemu-system-xtensa --version; \
    rm -rf "${IDF_TOOLS_PATH}/dist"

FROM nim-toolchain AS app-builder

ARG FRAMEOS_ARCHIVE_BASE_URL=https://archive.frameos.net
# quickts: QuickJS plus native TypeScript/JSX (github.com/FrameOS/quickts)
ARG QUICKJS_VERSION=2026-06-04-quickts.1
ARG QUICKJS_SHA256=94a94f5229ead78f585280b5d41c7b45ab5c53eaf3500e493a5da05f32030e9f
# emscripten, for the wasm live-preview bundle served by the frontend
ARG EMSCRIPTEN_VERSION=6.0.2

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      gnupg \
      make \
      pkg-config \
      xz-utils \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm@10.27.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------------------------------------------------------------------
# Layer ordering note: everything from here down to "COPY frontend frontend"
# is keyed only on files that change when a *dependency* changes, never on
# files a release bump rewrites (versions.json, the version field of
# frameos/wasm/package.json and frameos/editor/package.json). Keep it that
# way — putting a release-mutated file above these layers invalidates the
# whole toolchain install on every single release.
# ---------------------------------------------------------------------------

# Emscripten SDK for the wasm live-preview bundle. Pinned by ARG only, so it
# never depends on repository content: hoisted above the source COPYs, which
# used to force a full re-download of the SDK on every source change.
RUN set -eux; \
    git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk; \
    /opt/emsdk/emsdk install "${EMSCRIPTEN_VERSION}"; \
    /opt/emsdk/emsdk activate "${EMSCRIPTEN_VERSION}"

# Native QuickJS. Also pinned by ARG only (version + sha256), and it writes
# exclusively into /app/frameos/quickjs, which .dockerignore keeps out of the
# build context — so the later "COPY frameos frameos" merges around it and
# leaves this directory untouched.
RUN set -eux; \
    mkdir -p /tmp/quickjs-source /app/frameos/quickjs/include/quickjs; \
    curl -fsSL "${FRAMEOS_ARCHIVE_BASE_URL}/source/vendor/quickjs-${QUICKJS_VERSION}.tar.xz" -o /tmp/quickjs-source.tar.xz; \
    echo "${QUICKJS_SHA256}  /tmp/quickjs-source.tar.xz" | sha256sum -c -; \
    tar -xf /tmp/quickjs-source.tar.xz -C /tmp/quickjs-source; \
    quickjs_source_root="/tmp/quickjs-source/quickjs-${QUICKJS_VERSION}"; \
    make -C "${quickjs_source_root}" qjs libquickjs.a; \
    for quickjs_file in \
      LICENSE VERSION \
      quickjs.c dtoa.c libregexp.c libunicode.c cutils.c \
      quickts.h quickts_enum.h quickts_jsx.h \
      quickjs.h quickjs-libc.h cutils.h list.h dtoa.h libregexp.h libregexp-opcode.h libunicode.h libunicode-table.h quickjs-atom.h quickjs-opcode.h; \
    do \
      cp -a "${quickjs_source_root}/${quickjs_file}" "/app/frameos/quickjs/${quickjs_file}"; \
    done; \
    cp -a "${quickjs_source_root}/quickjs.h" /app/frameos/quickjs/quickjs.h; \
    cp -a "${quickjs_source_root}/quickjs-libc.h" /app/frameos/quickjs/quickjs-libc.h; \
    cp -a "${quickjs_source_root}/quickjs.h" /app/frameos/quickjs/include/quickjs/quickjs.h; \
    cp -a "${quickjs_source_root}/quickjs-libc.h" /app/frameos/quickjs/include/quickjs/quickjs-libc.h; \
    cp -a "${quickjs_source_root}/libquickjs.a" /app/frameos/quickjs/libquickjs.a; \
    cp -a "${quickjs_source_root}/qjs" /app/frameos/quickjs/qjs; \
    chmod +x /app/frameos/quickjs/qjs; \
    strip /app/frameos/quickjs/qjs; \
    /app/frameos/quickjs/qjs -e 'console.log("quickjs ok")'; \
    rm -rf /tmp/quickjs-source /tmp/quickjs-source.tar.xz

# `pnpm fetch` populates the content-addressable store from the lockfile
# alone — the package manifests are ignored — so the one layer that talks to
# the npm registry is keyed on pnpm-lock.yaml and nothing else.
#
# The node_modules/ that fetch leaves behind is dropped in the same layer, on
# purpose. Everything `pnpm install` needs is already in the global store, and
# installing on top of a fetch-populated virtual store makes pnpm skip the
# NODE_PATH preamble of its bin shims — which would make the published image
# differ, byte for byte, from the one a plain `pnpm install` produces.
COPY pnpm-lock.yaml ./
RUN pnpm fetch && rm -rf /app/node_modules

# Nim dependencies next, still above the package manifests: nimble.lock and
# friends change only when a Nim dependency changes.
COPY frameos/frameos.nimble frameos/nimble.lock frameos/nim.cfg frameos/config.nims frameos/
WORKDIR /app/frameos
RUN nimble install -d -y && nimble setup

COPY frameos/remote/frameos_remote.nimble frameos/remote/nimble.lock frameos/remote/config.nims /app/frameos/remote/
WORKDIR /app/frameos/remote
RUN nimble install -d -y && nimble setup

# The package manifests come last of the dependency inputs, because a release
# bump rewrites the version field of frameos/wasm/package.json and
# frameos/editor/package.json. What they invalidate from here on is local and
# cheap: the store is already populated, so --offline hardlinks out of it and
# never touches the network.
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY frontend/package.json frontend/package.json
COPY frameos/frontend/package.json frameos/frontend/package.json
COPY frameos/wasm/package.json frameos/wasm/package.json
COPY frameos/editor/package.json frameos/editor/package.json
RUN pnpm install --offline --frozen-lockfile

COPY frontend frontend
COPY repo/apps repo/apps
COPY repo/scenes repo/scenes
# build_wasm.sh runs makeapploaders.py, which loads the Nim codegen from
# backend/app/codegen (self-contained, no backend package imports), so copy
# just that directory into this stage.
COPY backend/app/codegen /app/backend/app/codegen
COPY frameos frameos
# versions.json is rewritten by every release commit, so it enters the image
# as late as it possibly can: right above its first consumer. Everything
# below genuinely depends on it — prepare_assets.py hashes it (it is in
# REPO_ROOT_FILES), build_wasm.sh bakes it into -d:frameosVersion, and the
# frontend imports it directly.
COPY versions.json ./

WORKDIR /app/frameos
RUN nimble assets -y

# Interpreted-scene runtime compiled to WebAssembly for the frontend's live
# preview modal; lands in frontend/public/frameos-wasm so the frontend build
# below copies it into dist.
RUN bash -c 'source /opt/emsdk/emsdk_env.sh && bash /app/frameos/tools/build_wasm.sh'

WORKDIR /app/frontend
RUN pnpm run build

RUN find /app/frameos -path '*/tests' -type d -prune -exec rm -rf {} + \
    && rm -rf \
      /app/frameos/frontend \
      /app/frameos/build \
      /app/frameos/nimcache \
      /app/frameos/testresults \
      /app/frameos/tmp \
      /app/frameos/remote/build \
      /app/frameos/remote/tmp

# The editor's JavaScript validation links the same QuickJS the frames run.
WORKDIR /app/frameos
RUN nim c -d:release --hints:off \
      --nimCache:/tmp/frameos-js-check-nimcache \
      --out:/app/frameos/build/js_check \
      tools/js_check.nim \
    && test -x /app/frameos/build/js_check \
    && rm -rf /tmp/frameos-js-check-nimcache

FROM esp-idf-toolchain AS esp32-ci

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/nim/bin:${PATH}"

WORKDIR /app

COPY --from=nim-toolchain /opt/nim /opt/nim

# Toolchain smoke test, kept directly above the source copies so it stays
# cached: it only reads /opt/nim and the ESP-IDF export from the base stage.
RUN bash -lc 'set -euo pipefail; . "${IDF_PATH}/export.sh" >/dev/null 2>&1; export PATH="/opt/nim/bin:${PATH}"; nim --version; qemu-system-xtensa --version'

COPY --from=app-builder /root/.nimble /root/.nimble
COPY backend/app backend/app
COPY embedded embedded
COPY repo/apps repo/apps
COPY repo/scenes repo/scenes
COPY --from=app-builder /app/frameos /app/frameos

FROM ${PYTHON_IMAGE} AS python-deps

ENV DEBIAN_FRONTEND=noninteractive
ENV VIRTUAL_ENV=/app/backend/.venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

WORKDIR /app/backend

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libffi-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt backend/requirements.docker.in ./
RUN pip install --no-cache-dir --upgrade uv \
    && uv venv \
    && sed -E 's/^fastapi\[standard\]==/fastapi==/' requirements.txt > /tmp/requirements.constraints.txt \
    && uv pip install --no-cache-dir -c /tmp/requirements.constraints.txt -r requirements.docker.in \
    && find "${VIRTUAL_ENV}" -type f \( -name '*.so' -o -name '*.so.*' \) -exec strip --strip-unneeded {} + \
    && find "${VIRTUAL_ENV}" -type d -name __pycache__ -prune -exec rm -rf {} + \
    && find "${VIRTUAL_ENV}" -type f -name '*.pyc' -delete

FROM ${PYTHON_IMAGE} AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV VIRTUAL_ENV=/app/backend/.venv
ENV FRAMEOS_JS_CHECK=/app/frameos/build/js_check
ENV IDF_PATH=/opt/esp/esp-idf
ENV IDF_TOOLS_PATH=/opt/esp/idf-tools
ENV PATH="/opt/nim/bin:${VIRTUAL_ENV}/bin:${PATH}"

WORKDIR /app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      bison \
      build-essential \
      ca-certificates \
      ccache \
      cmake \
      curl \
      dfu-util \
      dosfstools \
      e2fsprogs \
      flex \
      genimage \
      git \
      gnupg \
      gperf \
      iputils-ping \
      libgcrypt20 \
      libffi-dev \
      libglib2.0-0 \
      libpixman-1-0 \
      libsdl2-2.0-0 \
      libssl-dev \
      libslirp0 \
      libusb-1.0-0 \
      mtools \
      ninja-build \
      python3-pip \
      python3-setuptools \
      python3-venv \
      redis-server; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg; \
    chmod a+r /etc/apt/keyrings/docker.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin; \
    # Node hosts the wasm scene runtime for ESP32 thin-client renders
    # (backend/tools/embedded_wasm_render.mjs); without it the render
    # endpoint falls back to the diagnostic bitmap.
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*

COPY --from=nim-toolchain /opt/nim /opt/nim
COPY --from=esp-idf-toolchain /opt/esp /opt/esp

# Only reads /opt/esp, so keep it above the copies that change every build.
RUN bash -lc 'set -euo pipefail; . "${IDF_PATH}/export.sh" >/dev/null 2>&1; qemu-system-xtensa --version'

RUN mkdir -p /app/db

COPY --from=app-builder /root/.nimble /root/.nimble
COPY --from=python-deps /app/backend/.venv /app/backend/.venv

COPY docker-entrypoint.sh ./
COPY backend backend
COPY embedded embedded
COPY repo/apps repo/apps
COPY repo/scenes repo/scenes
COPY tools/prebuilt-deps/manifest.json tools/prebuilt-deps/manifest.json
COPY --from=app-builder /app/frontend/dist frontend/dist
COPY --from=app-builder /app/frontend/schema frontend/schema
COPY --from=app-builder /app/frameos frameos
# Last, so a release bump does not invalidate (and force a re-push of) every
# layer above it.
COPY versions.json ./

EXPOSE 8989

CMD ["./docker-entrypoint.sh"]
