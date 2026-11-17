# Noun ART: the Gemini reader (Cloud Run Job "art-reader").
# Build from the REPO ROOT, because the worker shares code with the app (src/lib/ai/reader, src/lib/drive):
#   docker build -f worker/Dockerfile -t art-reader .
# worker/setup.sh does this for you in Google Cloud Shell.

FROM node:22-slim AS build
WORKDIR /app
COPY worker/package.json worker/package-lock.json worker/
RUN cd worker && npm ci --no-audit --no-fund
COPY worker/src worker/src
COPY worker/tsconfig.json worker/
COPY src/lib src/lib
RUN cd worker && npm run build

FROM node:22-slim
# ffmpeg reads only the SOUND of a clip, straight from Google Drive. The picture is never stored and never sent anywhere.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/worker/dist/main.mjs ./main.mjs
USER node
CMD ["node", "main.mjs"]
