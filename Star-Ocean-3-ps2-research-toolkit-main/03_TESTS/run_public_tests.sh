#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
export PYTHONDONTWRITEBYTECODE=1

python3 tools/python/verify_public_tree.py
python3 02_SOURCE/build_release.py
cmp 01_RELEASE/so3_resource_explorer_v5_12_8_pass6_2.html browser/so3_browser_disc_investigator.html

python3 - <<'PY'
import ast
from pathlib import Path
for pattern in ("02_SOURCE/*.py", "tools/python/*.py", "03_TESTS/*.py"):
    for path in Path(".").glob(pattern):
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
PY
for source in 02_SOURCE/*.js 03_TESTS/*.js; do
  node --check "$source"
done

node 03_TESTS/test_integration_smoke.js
node 03_TESTS/test_v510_targeted_runtime.js
node 03_TESTS/test_v5128_hybrid_bridge.js
node 03_TESTS/test_v53_movie_decoder.js
node 03_TESTS/test_v54_sac_decoder.js
node 03_TESTS/test_v55_mpeg_muxer.js
node 03_TESTS/test_v581_legacy.js
node 03_TESTS/test_v58_catalog.js
node 03_TESTS/test_v590_runtime_capture.js
python3 03_TESTS/test_python_decoder.py
python3 03_TESTS/test_v5128_hybrid_bundle.py

python3 tools/python/verify_public_tree.py
echo "SO3 public repository suite: PASS"
