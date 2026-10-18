#!/bin/sh
# NemoDots fast demo: reset the checkout to its healthy baseline, then run the
# API server (NemoDots runtime mounted at /api/nemodots) on $PORT.
# Usage: scripts/nemodots/demo-server.sh   (from NemoDots/)
set -e
export NEMODOTS_INSTANCE="${NEMODOTS_INSTANCE:-demo2}"
PORT="${PORT:-4560}"
VITE_PORT="${VITE_PORT:-5180}"
npm run -s nemodots:stack -- start
npm run -s nemodots:migrate
npm run -s nemodots:seed -- --reset-config
# Drop cached catalog blobs so every run starts from the same cache state.
node scripts/nemodots/stack.mjs exec -- sh -c \
  'redis-cli -u "$NEMODOTS_REDIS_URL" --scan --pattern "$NEMODOTS_REDIS_PREFIX:cache:*" | xargs -n 100 redis-cli -u "$NEMODOTS_REDIS_URL" unlink >/dev/null; echo "redis cache reset"'
exec env PORT="$PORT" HOST=127.0.0.1 NODE_ENV=development \
  APP_ORIGIN="http://127.0.0.1:$VITE_PORT,http://localhost:$VITE_PORT" \
  DATABASE_PATH="${DATABASE_PATH:-data/nemodots-demo.sqlite}" \
  node --env-file-if-exists=.env --import tsx src/server/index.ts
