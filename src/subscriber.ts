/**
 * Google Cloud Pub/Sub 구독자
 *
 * 구글폼 제출 → Apps Script → Pub/Sub 토픽 발행
 *                                   ↓
 *                         이 모듈이 메시지를 수신해서 즉시 처리
 */
import { PubSub, Message } from '@google-cloud/pubsub';
import * as path from 'path';
import * as fs from 'fs';
import { getSheetClient, getRowData, updateRowStatus, updateRowSuccess, updateRowFailed } from './sheets';
import { runTest } from './runner';
import { logger } from './logger';

const PROJECT_ID        = process.env['GCP_PROJECT_ID']      ?? 'personalities-automation';
const SUBSCRIPTION_NAME = process.env['PUBSUB_SUBSCRIPTION']  ?? 'form-submissions-mac';
const SCREENSHOT_DIR    = process.env['SCREENSHOT_DIR']       ?? './screenshots';
const HEADLESS          = process.env['HEADLESS']             !== 'false';
// 구글폼 응답이 쌓이는 시트 이름 (.env의 SHEET_NAME)
const SHEET_NAME        = process.env['SHEET_NAME']           || undefined;

// 서비스 계정 키 파일 경로 (로컬 실행 시 인증에 사용)
const KEY_FILE = (() => {
  const raw = process.env['GOOGLE_KEY_FILE'];
  if (!raw) return null;
  const resolved = path.resolve(raw);
  return fs.existsSync(resolved) ? resolved : null;
})();

// ──────────────────────────────────────────────
// 메시지 한 건 처리
// ──────────────────────────────────────────────
async function handleMessage(message: Message): Promise<void> {
  let rowNumber = 0;
  let spreadsheetId = '';

  try {
    const data = JSON.parse(message.data.toString()) as {
      spreadsheetId: string;
      rowNumber: number;
      sheetName?: string;
    };

    rowNumber     = data.rowNumber;
    spreadsheetId = data.spreadsheetId ?? process.env['SPREADSHEET_ID'] ?? '';

    logger.info(`Pub/Sub 메시지 수신 → row ${rowNumber} (spreadsheet: ${spreadsheetId})`);

    // 즉시 ACK → 재전송 방지
    message.ack();

    const sheetsClient = await getSheetClient();
    const row          = await getRowData(sheetsClient, spreadsheetId, rowNumber, SHEET_NAME);

    // 이미 처리 중이거나 완료된 행은 건너뜀
    if (row.status === 'RUNNING' || row.status === 'DONE') {
      logger.info(`Row ${rowNumber} 이미 ${row.status} 상태 → 건너뜀`);
      return;
    }

    // RUNNING 으로 마킹
    await updateRowStatus(sheetsClient, spreadsheetId, rowNumber, 'RUNNING', SHEET_NAME);
    logger.info(`Row ${rowNumber} → RUNNING  (${row.name} / ${row.jobPosition})`);

    // Playwright 테스트 실행
    const result = await runTest(
      row.answers,
      SCREENSHOT_DIR,
      `${rowNumber}_${row.name}`,
      HEADLESS,
    );

    // 성공 결과 기록
    await updateRowSuccess(
      sheetsClient, spreadsheetId, rowNumber,
      result.resultType, result.resultTraits, result.resultUrl,
      SHEET_NAME,
    );

    logger.info(
      `Row ${rowNumber} → DONE\n` +
      `   BM → ${result.resultType}\n` +
      `   BN → ${result.resultTraits}`,
    );

  } catch (err) {
    logger.error(`Row ${rowNumber} 처리 실패`, err);

    if (spreadsheetId && rowNumber) {
      try {
        const client = await getSheetClient();
        await updateRowFailed(client, spreadsheetId, rowNumber, SHEET_NAME);
      } catch {
        logger.warn('FAILED 상태 기록 중 오류');
      }
    }
  }
}

// ──────────────────────────────────────────────
// Pub/Sub 구독 시작 (서버가 켜질 때 자동 호출)
// ──────────────────────────────────────────────
export function startSubscriber(): void {
  // 로컬: 키 파일로 인증 / Cloud Run: ADC(자동) 사용
  const pubsub = new PubSub({
    projectId: PROJECT_ID,
    ...(KEY_FILE ? { keyFilename: KEY_FILE } : {}),
  });
  const subscription = pubsub.subscription(SUBSCRIPTION_NAME);

  subscription.on('message', handleMessage);

  subscription.on('error', (err) => {
    logger.error('Pub/Sub 구독 오류', err);
  });

  subscription.on('close', () => {
    logger.warn('Pub/Sub 구독 연결 종료 — 5초 후 재연결');
    setTimeout(startSubscriber, 5_000);
  });

  logger.info(`Pub/Sub 구독 시작: ${SUBSCRIPTION_NAME} (project: ${PROJECT_ID})`);
}
