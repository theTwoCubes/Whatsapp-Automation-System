#!/usr/bin/env bash
# Runs the full test suite against a throwaway test database and saves a
# timestamped report under qa/results/. Usage: bash qa/run.sh (or npm run qa).
set -uo pipefail

cd "$(dirname "$0")/.."
mkdir -p qa/results

stamp="$(date +%Y%m%d-%H%M%S)"
out="qa/results/run-$stamp.log"

export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://whatsapp:whatsapp@localhost:5432/whatsapp_test}"
export LOG_LEVEL="${LOG_LEVEL:-silent}"

{
  echo "qa run $stamp"
  echo "database: $TEST_DATABASE_URL"
  echo
  node --test --test-concurrency=1 qa/tests/*.test.js
} 2>&1 | tee "$out"

code=${PIPESTATUS[0]}
echo | tee -a "$out"
echo "exit code: $code" | tee -a "$out"
echo "report saved to $out"
exit "$code"
