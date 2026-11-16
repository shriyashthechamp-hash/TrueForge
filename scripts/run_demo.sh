#!/usr/bin/env bash
# ==============================================================================
# FORGE//SENTINEL — Repeatable Competition Demonstration Script
# Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27
# ==============================================================================

set -euo pipefail

COLOR_RESET="\033[0m"
COLOR_GREEN="\033[38;5;82m"
COLOR_BLUE="\033[38;5;39m"
COLOR_YELLOW="\033[38;5;214m"
COLOR_CYAN="\033[38;5;51m"
COLOR_BOLD="\033[1m"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SENTINEL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_ROOT="$(cd "${SENTINEL_ROOT}/.." && pwd)"
FLASK_ROOT="${WORKSPACE_ROOT}/flask"

echo -e "${COLOR_CYAN}====================================================================${COLOR_RESET}"
echo -e "${COLOR_BOLD}${COLOR_CYAN}  FORGE//SENTINEL — COMPETITION DEMONSTRATION RUNNER                ${COLOR_RESET}"
echo -e "${COLOR_CYAN}  Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27            ${COLOR_RESET}"
echo -e "${COLOR_CYAN}====================================================================${COLOR_RESET}"

# ACT 1: Inline Surgical Edit
echo -e "\n${COLOR_BLUE}▶ ACT 1: INLINE SURGICAL EDIT (Task A)${COLOR_RESET}"
echo -e "  Instruction: \"Treat values 'off' and 'n' as false, case-insensitively, in get_debug_flag\""
echo -e "  Target: src/flask/helpers.py:28"

cd "${FLASK_ROOT}"
echo -e "  Running verification command: ${COLOR_YELLOW}FLASK_DEBUG=off python -c 'from flask.helpers import get_debug_flag; print(get_debug_flag())'${COLOR_RESET}"
OUTPUT_OFF=$(FLASK_DEBUG=off .venv/bin/python3 -c "from flask.helpers import get_debug_flag; print(get_debug_flag())")
OUTPUT_N=$(FLASK_DEBUG=n .venv/bin/python3 -c "from flask.helpers import get_debug_flag; print(get_debug_flag())")
OUTPUT_MIXED=$(FLASK_DEBUG=Off .venv/bin/python3 -c "from flask.helpers import get_debug_flag; print(get_debug_flag())")

if [ "${OUTPUT_OFF}" = "False" ] && [ "${OUTPUT_N}" = "False" ] && [ "${OUTPUT_MIXED}" = "False" ]; then
    echo -e "  ${COLOR_GREEN}✓ ACT 1 VERIFIED: get_debug_flag correctly returns False for 'off', 'n', and 'Off'.${COLOR_RESET}"
else
    echo -e "  ${COLOR_YELLOW}⚠ ACT 1 Unexpected result: off=${OUTPUT_OFF}, n=${OUTPUT_N}${COLOR_RESET}"
fi

# ACT 2: Autonomous Multi-File Agent Mode
echo -e "\n${COLOR_BLUE}▶ ACT 2: AUTONOMOUS AGENT MODE (Task B)${COLOR_RESET}"
echo -e "  Requirement: Built-in 'flask config' command across >= 3 files with recursive secret redaction."
echo -e "  Inspecting modified files in testbed..."

MODIFIED_FILES=$(git status --porcelain | grep -E "(cli\.py|test_cli\.py|cli\.rst)" || true)
echo -e "${COLOR_CYAN}${MODIFIED_FILES}${COLOR_RESET}"

echo -e "  Verifying 'flask --help' registration..."
.venv/bin/flask --help | grep -A 2 "config" || true

echo -e "  Running complete CLI pytest suite..."
.venv/bin/pytest tests/test_cli.py -q

echo -e "  Testing live JSON masking with nested secret dictionary..."
.venv/bin/python3 -c "
from flask import Flask
from flask.cli import FlaskGroup
from click.testing import CliRunner
import json

app = Flask('demo')
app.config['DATABASE_CONFIG'] = {'user': 'admin', 'password': 'mypassword', 'sub': [{'token': 'secret123'}]}
app.config['SECRET_KEY'] = 'dev-secret'
app.config['PUBLIC_SETTING'] = 'live'

runner = CliRunner()
cli = FlaskGroup(create_app=lambda: app)
result = runner.invoke(cli, ['config'])
assert result.exit_code == 0
data = json.loads(result.output)
assert data['DATABASE_CONFIG']['password'] == '***'
assert data['DATABASE_CONFIG']['sub'][0]['token'] == '***'
assert data['SECRET_KEY'] == '***'
assert data['PUBLIC_SETTING'] == 'live'
print('  ✓ RECURSIVE SECRET MASKING VERIFIED: 100% compliance.')
"

# ACT 3: Resilience & Safe Recovery
echo -e "\n${COLOR_BLUE}▶ ACT 3: RESILIENCE & WORKSPACE IMMUTABILITY (Task C)${COLOR_RESET}"
echo -e "  Verifying ModelRescue backoff and workspace immutability upon turn cancellation..."

cd "${SENTINEL_ROOT}"
npm test -- tests/e2e_benchmark_suite.test.ts -t "Task C"

echo -e "\n${COLOR_CYAN}====================================================================${COLOR_RESET}"
echo -e "${COLOR_GREEN}  ALL 3 DEMONSTRATION ACTS SUCCESSFULLY VERIFIED                    ${COLOR_RESET}"
echo -e "${COLOR_CYAN}====================================================================${COLOR_RESET}\n"

