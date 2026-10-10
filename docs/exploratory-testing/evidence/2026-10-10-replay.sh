#!/bin/sh
# Replays each confirmed 2026-10-10 finding from a fresh fixture directory.
# Usage: sh replay.sh
# Override with an absolute command: MX="node /path/to/dist/cli.js" sh replay.sh
set -u
if [ -z "${MX:-}" ]; then
  ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
  MX="node $ROOT/dist/cli.js"
fi
D=$(mktemp -d)
cd "$D" || exit 1
run() { echo "\$ messcript $*"; $MX "$@"; echo "exit=$?"; echo; }

echo "## 1 LCOM bare identifier"
cat > bag.ts << 'EOF'
export class Bag {
  left = 0;
  right = 0;
  bumpLeft() {
    this.left += 1;
  }
  bumpRight() {
    return left;
  }
}
EOF
cat > control.ts << 'EOF'
export class Bag {
  left = 0;
  right = 0;
  bumpLeft() {
    this.left += 1;
  }
  bumpRight() {
    this.right += 1;
  }
}
EOF
run bag.ts text design --only LackOfCohesionOfMethods
run control.ts text design --only LackOfCohesionOfMethods

echo "## 2 object-literal methods"
cat > handlers.ts << 'EOF'
export const handlers = {
  Bad_Name() {
    return 1;
  },
  ab() {
    return 1;
  },
  getActive() {
    return true;
  },
};

export class Screen {
  Bad_Name() {
    return 1;
  }
  ab() {
    return 1;
  }
  getActive() {
    return true;
  }
}
EOF
run handlers.ts text typescript
rm -rf "$D"
