#!/bin/sh
# Build Plow's OpenClaw base image from source for this machine's architecture.
#
# LOCAL DEVELOPMENT ONLY. The published base is linux/amd64 only. On Apple
# Silicon, Docker runs it emulated, and that emulation has no openat2 syscall,
# which OpenClaw 2026.9.6 needs for its state lock: the gateway exits with 78
# ("the Gateway or another SQLite maintenance command owns this state
# directory"). The base's source builds natively instead, because the OpenClaw
# image it starts from is multi-arch.
#
# Production is unchanged: the Dockerfile's default BASE_IMAGE is still the
# published base, pinned by digest. compose.arm64.yml points a local build at
# the image this script tags.
#
# Known gap: at this commit the base downloads agentsview for amd64 only, so a
# native arm64 build cannot collect token usage for the Agent Index. The agent
# itself is unaffected.
set -eu

REPO=https://github.com/plow-pbc/plow-openclaw-agent.git
# Keep in step with the base-<sha> tag in the Dockerfile.
REV=1e73c82c4b3e0c9f76935bc0cc45061875b34aee
TAG=plow-openclaw-base:1e73c82-local

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
git -C "$work" fetch -q --depth 1 "$REPO" "$REV"
git -C "$work" checkout -q FETCH_HEAD

docker build --build-arg PLOW_REVISION="$REV" -t "$TAG" "$work"
echo "built $TAG"
