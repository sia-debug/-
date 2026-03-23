// ══════════════════════════════════════════════════════════════
// Google Sheets 컬럼 인덱스 (0-based)
//
//  A  =  0  타임스탬프
//  B  =  1  성함
//  C  =  2  지원직무
//  D  =  3  문항 1
//  …
//  BK = 62  문항 60
//  BL = 63  process_status  ← PENDING(빈칸) / RUNNING / DONE / FAILED
//  BM = 64  성격유형         ← "성격유형: ENFJ-T(선도자)"
//  BN = 65  성격특성 비율    ← "외향형 – 58%, 직관형 – 56%, ..."
//  BO = 66  결과 URL
//  BP = 67  처리 완료 시각
// ══════════════════════════════════════════════════════════════
export const SHEET_COLS = {
  TIMESTAMP:     0,   // A
  NAME:          1,   // B
  JOB:           2,   // C
  ANSWERS_START: 3,   // D  (문항 1)
  ANSWERS_END:   62,  // BK (문항 60)
  STATUS:        63,  // BL process_status
  RESULT_TYPE:   64,  // BM 성격유형
  RESULT_TRAITS: 65,  // BN 성격특성 비율
  RESULT_URL:    66,  // BO 결과 URL
  PROCESSED_AT:  67,  // BP 처리 완료 시각
} as const;

export const TOTAL_QUESTIONS    = 60;
export const QUESTIONS_PER_PAGE = 6;
export const TOTAL_PAGES        = TOTAL_QUESTIONS / QUESTIONS_PER_PAGE; // 10

// ──────────────────────────────────────────────
// 도메인 타입
// ──────────────────────────────────────────────

export type ProcessStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';

/** 시트에서 읽어온 응답 행 */
export interface SurveyRow {
  rowIndex:    number;
  name:        string;
  jobPosition: string;
  answers:     number[];    // 길이 60, 값 1~7
  status:      ProcessStatus;
}

/** Playwright 테스트 결과 */
export interface TestResult {
  /** 예: "성격유형: ENFJ-T(선도자)" */
  resultType:   string;
  /** 예: "외향형 – 58%, 직관형 – 56%, 감정형 – 61%, 계획형 – 56%, 민감형 – 58%" */
  resultTraits: string;
  /** 결과 페이지 URL */
  resultUrl:    string;
}

/** POST /process 요청 바디 */
export interface ProcessRequest {
  /** 생략 시 환경변수 SPREADSHEET_ID 사용 */
  spreadsheetId?: string;
  /** 생략 시 첫 번째 시트 사용 */
  sheetName?:     string;
  /** 1-based 행 번호 (헤더 제외, 최솟값 2) */
  rowNumber:      number;
}

/** POST /process 응답 바디 */
export interface ProcessResponse {
  success:       boolean;
  rowNumber:     number;
  resultType?:   string;
  resultTraits?: string;
  resultUrl?:    string;
  message?:      string;
  error?:        string;
}
