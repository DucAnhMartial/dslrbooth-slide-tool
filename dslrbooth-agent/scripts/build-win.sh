#!/usr/bin/env bash
set -euo pipefail

# Builds the Windows installer, portable executable and zip from this Linux
# machine (10-RESEARCH R1, Pitfall 2, success criterion 5).
#
# electron-builder's icon/version resource-embedding step (rcedit) bundles a
# Windows .exe of its own and needs Wine to run it -- for EVERY Windows
# target, including the zip, and REGARDLESS of whether signing is
# configured (signing and resource-editing are two separate steps; turning
# one off does not turn off the other). This machine has no Wine installed
# directly, so only the packaging step below -- never the TypeScript
# compile -- runs inside electron-builder's own published Wine image
# (electronuserland/builder:wine).
#
# No code-signing certificate is in this phase's scope
# (10-RESEARCH's "What a Linux Build Honestly Cannot Do" #1). That is a
# deliberate, permanent gap for this phase, not an unfinished corner:
# electron-builder.json (this script's sibling) carries no signing key of
# any kind -- no certificateFile, no certificateSubjectName, no
# certificateSha1, no signingHashAlgorithms -- and CSC_IDENTITY_AUTO_DISCOVERY
# is switched off below so the tool never goes looking for a certificate on
# this machine either. The operator-facing consequence (the "Windows
# protected your PC" warning, and what Smart App Control does instead) is
# documented in docs/OPS-RUNBOOK-AGENT.md, not left to be discovered on the
# booth PC.
#
# Three details below are not decoration:
#   1. The container runs AS THE INVOKING USER, with its home and every
#      cache it touches pointed INSIDE this repository -- otherwise every
#      artifact lands owned by root and the next build from the host fails
#      on permissions with a message that explains nothing.
#   2. The repository is MOUNTED directly, not reinstalled inside the
#      container -- this project has zero native Node modules anywhere in
#      its tree (verified in research: no binding.gyp, no .node files), so
#      the host's already-installed dependencies are valid as-is inside the
#      container, and a fresh `npm install` inside it would only cost
#      minutes and network for no benefit.
#   3. The resolved image digest is recorded into the output directory and
#      is meant to be quoted in the runbook -- an unsigned artifact's
#      provenance is the only provenance it has.
#
# Fallback (documented, not run by default): if the direct repository mount
# ever misbehaves, electron-builder's own docs recommend a named Docker
# volume for node_modules instead:
#   docker run --rm \
#     -v "$PWD":/project \
#     -v "${PWD##*/}-node-modules":/project/node_modules \
#     electronuserland/builder:wine \
#     /bin/bash -c "yarn && yarn dist"

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
IMAGE="electronuserland/builder:wine"
CACHE_DIR="$REPO_ROOT/.electron-builder-cache"
OUTPUT_DIR="$REPO_ROOT/release"

echo "build-win: compiling on the host..."
npm run build

echo "build-win: pulling ${IMAGE}..."
docker pull "$IMAGE"
IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "unresolved")
echo "build-win: resolved image digest: ${IMAGE_DIGEST}"

# Created on the host, as the invoking user, BEFORE the container ever
# starts -- so Docker never has to auto-create these mount points itself
# (which it would do as root, defeating point 1 above).
mkdir -p "$CACHE_DIR/electron" "$CACHE_DIR/electron-builder" "$CACHE_DIR/home" "$OUTPUT_DIR"

echo "build-win: packaging inside ${IMAGE} as uid $(id -u):$(id -g)..."
docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e "HOME=/project/.electron-builder-cache/home" \
  -e "ELECTRON_CACHE=/project/.electron-builder-cache/electron" \
  -e "ELECTRON_BUILDER_CACHE=/project/.electron-builder-cache/electron-builder" \
  -e "CSC_IDENTITY_AUTO_DISCOVERY=false" \
  -v "$REPO_ROOT":/project \
  -w /project \
  "$IMAGE" \
  npx electron-builder --win

echo "${IMAGE_DIGEST}" > "$OUTPUT_DIR/.builder-image-digest"
echo "build-win: done. Artifacts in ${OUTPUT_DIR}, image digest ${IMAGE_DIGEST}"
