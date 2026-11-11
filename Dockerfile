FROM node:22-bookworm-slim

WORKDIR /opt/render/project/src

COPY package.json ./
RUN npm install --omit=dev \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libreoffice-writer \
  && rm -rf /var/lib/apt/lists/*

COPY . ./

CMD ["node", "bootstrap-v133.js"]
