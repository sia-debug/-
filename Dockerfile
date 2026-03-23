# ════════════════════════════════════════════════════════════════
# Stage 1: TypeScript 빌드
# ════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# 패키지 설치 (devDependencies 포함 — 빌드에 필요)
COPY package*.json ./
RUN npm ci

# TypeScript 소스 빌드
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ════════════════════════════════════════════════════════════════
# Stage 2: 런타임
# Playwright 공식 이미지에는 Chromium + 필수 시스템 라이브러리 포함
# ════════════════════════════════════════════════════════════════
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# production 의존성만 설치
COPY package*.json ./
RUN npm ci --omit=dev

# 빌드 결과물 복사
COPY --from=builder /app/dist ./dist

# Cloud Run 기본 포트
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production
# Playwright: Docker 안에서 Chromium 실행 시 sandbox 비활성화 (runner.ts에서도 설정)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 서버 시작
CMD ["node", "dist/index.js"]
