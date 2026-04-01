/**
 * Google Cloud Pub/Sub 구독자
 *
 * 구글폼 제출 → Apps Script → Pub/Sub 토픽 발행
 *                                   ↓
 *                         이 모듈이 메시지를 수신해서 즉시 처리
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { PubSub, Message } from '@google-cloud/pubsub';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { getSheetClient, getRowData, updateRowStatus, updateRowSuccess, updateRowFailed } from './sheets';
import { runTest } from './runner';
import { logger } from './logger';

const PROJECT_ID        = process.env['GCP_PROJECT_ID']      ?? 'personalities-automation';
const SUBSCRIPTION_NAME = process.env['PUBSUB_SUBSCRIPTION']  ?? 'form-submissions-mac';
const SCREENSHOT_DIR    = process.env['SCREENSHOT_DIR']       ?? './screenshots';
const HEADLESS          = process.env['HEADLESS']             !== 'false';
// 구글폼 응답이 쌓이는 시트 이름 (.env의 SHEET_NAME)
const SHEET_NAME        = process.env['SHEET_NAME']           || undefined;

// ──────────────────────────────────────────────
// 인증 환경 정밀 점검
// ──────────────────────────────────────────────
const KEY_FILE = (() => {
  // 1. .env 파일 강제 로드 (한 번 더)
  const envPath = path.resolve(process.cwd(), '.env');
  console.log(`[AUTH] .env 경로 확인: ${envPath}`);
  dotenv.config({ path: envPath });

  // 2. 키 파일 경로 결정 (환경변수 우선, 없으면 기본값)
  const rawPath = process.env['GOOGLE_KEY_FILE'] || 'service-account-key.json';
  const resolved = path.resolve(process.cwd(), rawPath);
  
  console.log(`[AUTH] 시도 중인 키 경로: ${resolved}`);

  if (fs.existsSync(resolved)) {
    console.log(`✅ [AUTH] 키 파일을 찾았습니다! (크기: ${fs.statSync(resolved).size} bytes)`);
    return resolved;
  } else {
    console.error(`❌ [AUTH] 키 파일을 찾을 수 없습니다! 경로를 확인하세요.`);
    // 폴더 내 파일 목록 출력해서 도움 주기
    const files = fs.readdirSync(process.cwd());
    console.log(`[AUTH] 현재 폴더 파일 목록: ${files.join(', ')}`);
    return null;
  }
})();

console.log(`[AUTH] 사용될 Project ID: ${PROJECT_ID}`);
console.log(`[AUTH] 사용될 Subscription: ${SUBSCRIPTION_NAME}`);

// ──────────────────────────────────────────────
// 슬랙 알림 Webhook URL
// ──────────────────────────────────────────────
const SLACK_WEBHOOK_URL = process.env['SLACK_WEBHOOK_URL'] || '';

// ──────────────────────────────────────────────
// 슬랙 알림 발송 (내부 함수)
// ──────────────────────────────────────────────
async function sendSlackNotification(
  name: string,
  pos: string,
  mbtiType: string,
  mbtiTraits: string,
  resultUrl: string
): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    logger.info('SLACK_WEBHOOK_URL 이 설정되지 않아 알림을 건너뜁니다.');
    return;
  }

  const payload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '✨ 인적성 검사 완료 알림',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*성함*: ${name}` },
          { type: 'mrkdwn', text: `*포지션*: ${pos}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*결과 요약*: ${mbtiType}\n*특성*: ${mbtiTraits}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '상세 결과 보기 🔗', emoji: true },
            url: resultUrl,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '자동화 시스템이 검사를 성공적으로 완료했습니다.' },
        ],
      },
    ],
  };

  return new Promise((resolve) => {
    const req = https.request(
      SLACK_WEBHOOK_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      }
    );

    req.on('error', (err) => {
      logger.error('슬랙 알림 발송 실패', err);
      resolve();
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

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

    // 슬랙 알림 발송
    await sendSlackNotification(
      row.name,
      row.jobPosition,
      result.resultType,
      result.resultTraits,
      result.resultUrl
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
