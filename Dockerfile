# The console — the website with the ten-step installer — as a container, for
# hosts that run images rather than `npm start`. Railway can use either this
# or railway.json.
#
#   docker build -t self-optimisation-console .
#   docker run -p 3000:3000 self-optimisation-console     # then open http://localhost:3000
#
# GitHub sign-in is optional; pass its variables with -e (see console/.env.example).
#
# The harness has no npm dependencies (js-yaml is vendored), so there is no
# install step. Only the three things the console reads at run time are
# copied, never the whole checkout, and .dockerignore keeps every .env file
# out of the build context as well — a key in someone's local
# harness/.env.harness.local must never end up in an image.

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY package.json ./
COPY harness/ harness/
COPY console/ console/

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1

CMD ["node", "console/server.mjs"]
