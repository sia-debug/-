import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import * as path from 'path';
import * as fs from 'fs';
import { SHEET_COLS, TOTAL_QUESTIONS, SurveyRow, ProcessStatus } from './types';

// ──────────────────────────────────────────────
// 헬퍼: 0-based 컬럼 인덱스 → A1 표기
// 예) 0→A, 25→Z, 26→AA, 63→BL
// ──────────────────────────────────────────────
export function colLetter(index: number): string {
  let result = '';
  let n = index + 1;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

// ──────────────────────────────────────────────
// Google Sheets 클라이언트 생성
//  - 로컬: GOOGLE_KEY_FILE 환경변수의 JSON 키 파일 사용
//  - Cloud Run: Application Default Credentials(ADC) 자동 사용
// ──────────────────────────────────────────────
export async function getSheetClient(): Promise<sheets_v4.Sheets> {
  const keyFile    = process.env['GOOGLE_KEY_FILE'];
  const resolvedKey = keyFile ? path.resolve(keyFile) : null;
  const useKeyFile  = resolvedKey !== null && fs.existsSync(resolvedKey);

  const auth = new google.auth.GoogleAuth({
    ...(useKeyFile ? { keyFile: resolvedKey! } : {}),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

// ──────────────────────────────────────────────
// 특정 행 데이터 읽기
// ──────────────────────────────────────────────
export async function getRowData(
  client:        sheets_v4.Sheets,
  spreadsheetId: string,
  rowNumber:     number,
  sheetName?:    string,
): Promise<SurveyRow> {
  const endCol      = colLetter(SHEET_COLS.PROCESSED_AT);          // BP
  const rangePrefix = sheetName ? `'${sheetName}'!` : '';
  const range       = `${rangePrefix}A${rowNumber}:${endCol}${rowNumber}`;

  const res = await client.spreadsheets.values.get({ spreadsheetId, range });
  const row: string[] = (res.data.values?.[0] as string[] | undefined) ?? [];

  // process_status 파싱
  const rawStatus = (row[SHEET_COLS.STATUS] ?? '').trim().toUpperCase();
  const status: ProcessStatus =
    rawStatus === 'RUNNING' ? 'RUNNING' :
    rawStatus === 'DONE'    ? 'DONE'    :
    rawStatus === 'FAILED'  ? 'FAILED'  : 'PENDING';

  // 60개 답변 파싱 (없거나 파싱 불가 시 중립값 4)
  const answers: number[] = [];
  for (let q = SHEET_COLS.ANSWERS_START; q <= SHEET_COLS.ANSWERS_END; q++) {
    const raw = row[q];
    const val = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 4;
    answers.push(isNaN(val) ? 4 : Math.min(7, Math.max(1, val)));
  }

  return {
    rowIndex:    rowNumber,
    name:        (row[SHEET_COLS.NAME] ?? '').trim(),
    jobPosition: (row[SHEET_COLS.JOB]  ?? '').trim(),
    answers,
    status,
  };
}

// ──────────────────────────────────────────────
// process_status 단일 컬럼 업데이트 (BL)
// ──────────────────────────────────────────────
export async function updateRowStatus(
  client:        sheets_v4.Sheets,
  spreadsheetId: string,
  rowNumber:     number,
  status:        ProcessStatus,
  sheetName?:    string,
): Promise<void> {
  const col         = colLetter(SHEET_COLS.STATUS);  // BL
  const rangePrefix = sheetName ? `'${sheetName}'!` : '';

  await client.spreadsheets.values.update({
    spreadsheetId,
    range:            `${rangePrefix}${col}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody:      { values: [[status]] },
  });
}

// ──────────────────────────────────────────────
// 성공 결과 기록 (BL~BP)
//  BL: DONE
//  BM: "성격유형: ENFJ-T(선도자)"
//  BN: "외향형 – 58%, 직관형 – 56%, ..."
//  BO: 결과 URL
//  BP: 처리 완료 시각 (KST)
// ──────────────────────────────────────────────
export async function updateRowSuccess(
  client:        sheets_v4.Sheets,
  spreadsheetId: string,
  rowNumber:     number,
  resultType:    string,
  resultTraits:  string,
  resultUrl:     string,
  sheetName?:    string,
): Promise<void> {
  const startCol    = colLetter(SHEET_COLS.STATUS);        // BL
  const endCol      = colLetter(SHEET_COLS.PROCESSED_AT);  // BP
  const rangePrefix = sheetName ? `'${sheetName}'!` : '';
  const now         = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  await client.spreadsheets.values.update({
    spreadsheetId,
    range:            `${rangePrefix}${startCol}${rowNumber}:${endCol}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody:      { values: [['DONE', resultType, resultTraits, resultUrl, now]] },
  });
}

// ──────────────────────────────────────────────
// 실패 기록 (BL=FAILED, BM~BN 공란, BP=시각)
// ──────────────────────────────────────────────
export async function updateRowFailed(
  client:        sheets_v4.Sheets,
  spreadsheetId: string,
  rowNumber:     number,
  sheetName?:    string,
): Promise<void> {
  const startCol    = colLetter(SHEET_COLS.STATUS);        // BL
  const endCol      = colLetter(SHEET_COLS.PROCESSED_AT);  // BP
  const rangePrefix = sheetName ? `'${sheetName}'!` : '';
  const now         = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  await client.spreadsheets.values.update({
    spreadsheetId,
    range:            `${rangePrefix}${startCol}${rowNumber}:${endCol}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody:      { values: [['FAILED', '', '', '', now]] },
  });
}
