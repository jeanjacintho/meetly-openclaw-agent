# Meetly: a variant of Plow's OpenClaw base image (prompt + skills only).
# Pinned by digest: the base boots holding this agent's Plow credential.
# To bump, take a newer base-<sha> tag and its digest from
# https://gallery.ecr.aws/e1h7x4a2/plow-cloud-agents
# BASE_IMAGE is overridden only for local development on Apple Silicon
# (compose.arm64.yml, dev/build-base.sh); images you deploy use this default.
ARG BASE_IMAGE=public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-1e73c82c4b3e0c9f76935bc0cc45061875b34aee@sha256:5f8ef7c3762b037420cd8843a767a7ab7e2433b1c8319e7cfe2ad1bdef5dee8a
FROM ${BASE_IMAGE}

ENV AGENT_ID=meetly \
    AGENT_NAME=Meetly \
    AGENT_BLURB="Your scheduling assistant. It reads your iMessages, spots who wants to meet, and opens a group to book it on your calendar. Or ask it to reach out to anyone for you. Works both ways." \
    AGENT_RUNTIME="OpenClaw 2.0"

COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md
COPY skills/ /opt/plow/skills/
