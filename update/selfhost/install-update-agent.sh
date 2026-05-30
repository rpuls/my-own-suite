#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

exec bash "${REPO_DIR}/agents/selfhost/update/install.sh" "${REPO_DIR}"
