#!/bin/sh
# JARVIS test suite: harness/mock self-check, core unit tests, then the browser scenarios.
#   sh test/run-all.sh              (uses jarvis.html next to this folder)
#   JARVIS_HTML=/path/x.html sh test/run-all.sh
cd "$(dirname "$0")/.." || exit 2
status=0
echo "== 1/3 harness + mock self-check (stub page)"; node test/mock-selftest.cjs || status=1
echo; echo "== 2/3 core unit tests"; node test/core.test.cjs ${JARVIS_HTML:+"$JARVIS_HTML"} || status=1
echo; echo "== 3/3 end-to-end scenarios"; node test/e2e.cjs ${JARVIS_HTML:+--file "$JARVIS_HTML"} || status=1
exit $status
