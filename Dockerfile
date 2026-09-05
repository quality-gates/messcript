# Runtime image: docker build -t messcript . && docker run --rm -v "$PWD":/code messcript /code text opinionated
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN ln -s /app/dist/cli.js /usr/local/bin/messcript && chmod +x /app/dist/cli.js
WORKDIR /code
ENTRYPOINT ["messcript"]
CMD ["--help"]
