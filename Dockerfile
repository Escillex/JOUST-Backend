FROM node:22-alpine

# pg_dump / pg_restore / psql, for the in-app backup feature. The major is
# pinned to match the postgres:17-alpine service: a pg_dump older than the
# server it is dumping refuses to run, and a mismatch would only surface the
# first time somebody pressed "Back up now".
RUN apk add --no-cache postgresql17-client

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy Prisma schema + config and generate client (no .env needed — generate only reads schema)
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

# Copy the rest of the application
COPY . .

EXPOSE 4000

# Read by BackupService: outside a container it will not self-exit after a
# restore, because nothing would bring the process back.
ENV RUNNING_IN_DOCKER=true

CMD ["npm", "run", "start:dev"]
