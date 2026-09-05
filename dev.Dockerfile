# Development image: docker build -f dev.Dockerfile -t messcript-dev . && docker run --rm -it -v "$PWD":/workspace messcript-dev
FROM node:22-alpine
RUN apk add --no-cache git bash
WORKDIR /workspace
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "test"]
