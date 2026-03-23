import express, { Request, Response } from 'express';
import {
  getSheetClient,
  getRowData,
  updateRowStatus,
  updateRowSuccess,
  updateRowFailed,
} from './sheets';
import { runTest } from './runner';
import { logger } from './logger';
import { ProcessRequest, ProcessResponse } from './types';

// ──────────────────────────────────────────────
// Express 앱 생성 및 라우트 등록
// ──────────────────────────────────────────────
export function createServer(): express.Application {
  const app = express();
  app.use(express.json());

  const defaultSpreadsheetId = process.env['SPREADSHEET_ID'] ?? '';
  const screenshotDir        = process.env['SCREENSHOT_DIR'] ?? './screenshots';
  const headless             = process.env['HEADLESS'] !== 'false';

  // ════════════════════════════════════════════
  // GET /health  — Cloud Run 헬스체크
  // ════════════════════════════════════════════
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ════════════════════════════════════════════
  // POST /process  — 핵심 엔드포인트
  //
  // 요청 바디 (JSON):
  //   spreadsheetId  string  (생략 시 환경변수 SPREADSHEET_ID 사용)
  //   sheetName      string  (생략 시 첫 번째 시트)
  //   rowNumber      number  (1-based, 헤더 제외 → 최솟값 2)
  //
  // 응답:
  //   200  { success: true,  rowNumber, resultType, resultTraits, resultUrl }
  //   400  잘못된 요청 (rowNumber 없음 등)
  //   409  이미 RUNNING 중
  //   500  테스트 실패
  // ════════════════════════════════════════════
  app.post('/process', async (req: Request, res: Response): Promise<void> => {
    const body          = req.body as Partial<ProcessRequest>;
    const spreadsheetId = (body.spreadsheetId ?? defaultSpreadsheetId).trim();
    const sheetName     = body.sheetName;
    const rowNumber     = body.rowNumber;

    // ── 입력 검증 ──
    if (!spreadsheetId) {
      res.status(400).json({
        success: false,
        error: 'spreadsheetId가 없습니다. 환경변수 SPREADSHEET_ID를 설정하거나 요청 바디에 포함해주세요.',
      });
      return;
    }
    if (
      rowNumber === undefined ||
      typeof rowNumber !== 'number' ||
      !Number.isInteger(rowNumber) ||
      rowNumber < 2
    ) {
      res.status(400).json({
        success: false,
        error: 'rowNumber가 유효하지 않습니다 (2 이상의 정수 필요).',
      });
      return;
    }

    logger.info(
      `POST /process ← spreadsheetId=${spreadsheetId}  row=${rowNumber}${
        sheetName ? `  sheet="${sheetName}"` : ''
      }`
    );

    // ── Google Sheets 클라이언트 ──
    let sheetsClient;
    try {
      sheetsClient = await getSheetClient();
    } catch (err) {
      logger.error('Sheets 클라이언트 초기화 실패', err);
      res.status(500).json({ success: false, error: '인증 초기화 실패' });
      return;
    }

    // ── 행 데이터 읽기 ──
    let rowData;
    try {
      rowData = await getRowData(sheetsClient, spreadsheetId, rowNumber, sheetName);
    } catch (err) {
      logger.error(`Row ${rowNumber} 읽기 실패`, err);
      res.status(500).json({ success: false, error: '시트 읽기 실패' });
      return;
    }

    // ── 상태 확인 ──
    if (rowData.status === 'RUNNING') {
      res.status(409).json({
        success: false,
        error:   '이미 처리 중인 행입니다 (RUNNING). 잠시 후 다시 시도하세요.',
        rowNumber,
      });
      return;
    }
    if (rowData.status === 'DONE') {
      logger.info(`Row ${rowNumber} 이미 DONE → 건너뜀`);
      const response: ProcessResponse = {
        success:  true,
        rowNumber,
        message: '이미 처리 완료된 행입니다.',
      };
      res.json(response);
      return;
    }
    if (rowData.answers.length !== 60) {
      res.status(400).json({
        success: false,
        error:   `답변 수 오류: ${rowData.answers.length}개 (60개 필요)`,
        rowNumber,
      });
      return;
    }

    // ── RUNNING 상태로 변경 ──
    try {
      await updateRowStatus(sheetsClient, spreadsheetId, rowNumber, 'RUNNING', sheetName);
    } catch (err) {
      logger.error(`Row ${rowNumber} RUNNING 상태 기록 실패`, err);
      res.status(500).json({ success: false, error: '시트 상태 기록 실패' });
      return;
    }
    logger.info(`Row ${rowNumber} → RUNNING  (${rowData.name} / ${rowData.jobPosition})`);

    // ── Playwright 테스트 실행 ──
    const rowLabel = `${rowNumber}_${rowData.name || 'unknown'}`;
    try {
      const result = await runTest(
        rowData.answers,
        screenshotDir,
        rowLabel,
        headless,
      );

      await updateRowSuccess(
        sheetsClient,
        spreadsheetId,
        rowNumber,
        result.resultType,
        result.resultTraits,
        result.resultUrl,
        sheetName,
      );

      logger.success(
        `Row ${rowNumber} → DONE\n` +
        `  BM → ${result.resultType}\n` +
        `  BN → ${result.resultTraits}`
      );

      const response: ProcessResponse = {
        success:      true,
        rowNumber,
        resultType:   result.resultType,
        resultTraits: result.resultTraits,
        resultUrl:    result.resultUrl,
      };
      res.json(response);
    } catch (err) {
      logger.error(`Row ${rowNumber} 테스트 실패`, err);

      try {
        await updateRowFailed(sheetsClient, spreadsheetId, rowNumber, sheetName);
        logger.warn(`Row ${rowNumber} → FAILED`);
      } catch (writeErr) {
        logger.warn(`Row ${rowNumber} FAILED 상태 기록 중 오류`);
        logger.error('상태 기록 오류', writeErr);
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, rowNumber, error: errorMsg });
    }
  });

  return app;
}
