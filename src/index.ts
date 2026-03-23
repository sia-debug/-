// dotenv는 가장 먼저 로드
import * as dotenv from 'dotenv';
dotenv.config();

import { createServer } from './server';
import { startSubscriber } from './subscriber';
import { logger } from './logger';

const PORT          = parseInt(process.env['PORT'] ?? '8080', 10);
const USE_PUBSUB    = process.env['USE_PUBSUB'] !== 'false'; // 기본값: 활성화

const app = createServer();

app.listen(PORT, () => {
  logger.info('='.repeat(60));
  logger.info('16Personalities 자동화 서버 시작');
  logger.info(`포트         : ${PORT}`);
  logger.info(`Headless     : ${process.env['HEADLESS'] !== 'false'}`);
  logger.info(`Spreadsheet  : ${process.env['SPREADSHEET_ID'] ?? '(요청 시 지정)'}`);
  logger.info(`Screenshot   : ${process.env['SCREENSHOT_DIR'] ?? './screenshots'}`);
  logger.info(`Pub/Sub      : ${USE_PUBSUB ? '활성화' : '비활성화'}`);
  logger.info('='.repeat(60));
  logger.info('사용 가능한 엔드포인트:');
  logger.info(`  GET  http://localhost:${PORT}/health`);
  logger.info(`  POST http://localhost:${PORT}/process`);
  logger.info('='.repeat(60));

  // Pub/Sub 구독 시작 (구글폼 제출 시 자동 트리거)
  if (USE_PUBSUB) {
    startSubscriber();
  }
});
