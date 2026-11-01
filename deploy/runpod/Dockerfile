# OpenField judge preview for Runpod: ComfyUI 0.38 + comfy-api-proxy + OpenField
# in judge mode, one HTTP port (3161). Models are not in the image: start.sh
# downloads them to the pod's network volume (/workspace) on first boot.
#
# Build from the repository root:
#   docker build -f deploy/runpod/Dockerfile -t <you>/openfield-runpod:0.1.0 .
#
# Needs no GPU to build. CUDA 12.8 covers Ada (4090, L40S) and Blackwell (5090);
# the host driver must be 570 or newer.

ARG CUDA_IMAGE=nvidia/cuda:12.8.1-runtime-ubuntu24.04
FROM ${CUDA_IMAGE}

ARG NODE_VERSION=22.23.4
ARG COMFY_REF=v0.38.2
ARG TORCH_INDEX=https://download.pytorch.org/whl/cu128
ARG PROXY_VERSION=0.1.6

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# System: Python for ComfyUI, ffmpeg for OpenField, a compiler for native wheels
# and better-sqlite3, tini to reap ComfyUI and the proxy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils tini \
      python3 python3-venv python3-dev build-essential \
      ffmpeg libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# Node 22, the official build, pinned.
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
 && node -v && npm -v

# ComfyUI at a release tag, in its own venv (PEP 668 safe).
RUN git clone --filter=blob:none https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
 && git -C /opt/ComfyUI checkout --quiet "${COMFY_REF}" \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip wheel \
 && /opt/venv/bin/pip install torch torchvision torchaudio --index-url "${TORCH_INDEX}" \
 && /opt/venv/bin/pip install -r /opt/ComfyUI/requirements.txt \
 && mv /opt/ComfyUI/models /opt/ComfyUI/models.dist

# Custom node packs, each pinned by commit (deploy/runpod/nodes.txt).
COPY deploy/runpod/nodes.txt /opt/nodes.txt
RUN grep -Ev '^\s*(#|$)' /opt/nodes.txt | while read -r name url commit req; do \
      echo "== ${name} @ ${commit}"; \
      git clone --filter=blob:none "${url}" "/opt/ComfyUI/custom_nodes/${name}"; \
      git -C "/opt/ComfyUI/custom_nodes/${name}" checkout --quiet "${commit}"; \
      if [ -f "/opt/ComfyUI/custom_nodes/${name}/${req}" ]; then \
        /opt/venv/bin/pip install -r "/opt/ComfyUI/custom_nodes/${name}/${req}"; \
      fi; \
    done

# comfy-api-proxy (Comfy API v2 in front of ComfyUI), its own venv.
RUN python3 -m venv /opt/proxy \
 && /opt/proxy/bin/pip install "comfy-api-proxy==${PROXY_VERSION}" \
 && /opt/proxy/bin/comfy-api-proxy --help > /dev/null

# OpenField, built once. `npm start` runs the server through tsx (a dev
# dependency), so the dev dependencies stay.
WORKDIR /opt/openfield
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && chmod +x deploy/runpod/start.sh

ENV COMFY_DIR=/opt/ComfyUI \
    COMFY_PY=/opt/venv/bin/python \
    COMFY_PROXY_BIN=/opt/proxy/bin/comfy-api-proxy \
    OPENFIELD_DIR=/opt/openfield \
    OPENFIELD_JUDGE=1 \
    OPENFIELD_PORT=3161 \
    OPENFIELD_RENDER_TIER=720p

EXPOSE 3161
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/opt/openfield/deploy/runpod/start.sh"]
