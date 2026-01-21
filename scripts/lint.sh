#!/bin/bash
cd "$(dirname "$0")/.."
export ESLINT_USE_FLAT_CONFIG=false
exec ./node_modules/.bin/eslint "$@"
