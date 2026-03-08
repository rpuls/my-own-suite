FROM node@sha256:b501c082306a4f528bc4038cbf2fbb58095d583d0419a259b2114b5ac53d12e9

WORKDIR /app

COPY package*.json ./
RUN npm install -g npm@11.2.0 && npm ci --omit=dev

COPY src ./src

EXPOSE 3000

CMD ["node", "--experimental-strip-types", "src/index.ts"]
