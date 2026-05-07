FROM node:22-alpine

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

CMD ["npm", "run", "start:dev"]
