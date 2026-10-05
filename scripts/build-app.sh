#!/bin/bash
# Build the one deployable app in this workspace.
#
# The repository is a pnpm workspace, but Freebuff hosting builds a single
# package and serves a Vite app's static output from `dist/`. This script builds
# only @workspace/llm-social-simulation and places the result at the repository
# root's `dist/`, so hosting needs no workspace awareness. It is invoked as
# `sh ./scripts/build-app.sh`, so it stays POSIX-sh compatible and needs no
# executable bit.
set -e

# vite.config.ts requires both of these to be present, even for a build.
: "${BASE_PATH:=/}"
: "${PORT:=3000}"
export BASE_PATH PORT

pnpm --filter @workspace/llm-social-simulation run build

mkdir -p dist
cp -r artifacts/llm-social-simulation/dist/public/. dist/
