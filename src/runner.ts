import { chromium, type Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import {
  TestResult,
  QUESTIONS_PER_PAGE,
  TOTAL_PAGES,
  TOTAL_QUESTIONS,
} from './types';
import { logger } from './logger';
import { saveScreenshot, ensureDir } from './storage';

const TEST_URL =
  'https://www.16personalities.com/ko/%EB%AC%B4%EB%A3%8C-%EC%84%B1%EA%B2%A9-%EC%9C%A0%ED%98%95-%EA%B2%80%EC%82%AC';

// 결과 페이지 URL 패턴: /ko/결과/{type}/{variant}/x/{code}
// URL-encoded: %EA%B2%B0%EA%B3%BC = 결과
const RESULT_URL_RE = /%EA%B2%B0%EA%B3%BC|\/results?\//i;

// ──────────────────────────────────────────────
// 시트 값 1~7 → 라디오 value 속성 -3~3
//   1(왼쪽 매우 그렇다) → -3
//   4(중립)             →  0
//   7(오른쪽 매우 그렇다) → +3
// ──────────────────────────────────────────────
function toRadioValue(sheetValue: number): string {
  return (sheetValue - 4).toString();
}

// ──────────────────────────────────────────────
// 영어 → 한국어 번역 테이블
// 페이지가 영어로 렌더링되어도 항상 한국어로 출력
// ──────────────────────────────────────────────

/** 성격 유형 영어 이름 → 한국어 이름 */
const TYPE_NAME_KO: Record<string, string> = {
  // 분석가 (Analysts)
  Architect:    '건축가',
  Logician:     '논리술사',
  Commander:    '통솔자',
  Debater:      '변론가',
  // 외교관 (Diplomats)
  Advocate:     '옹호자',
  Mediator:     '중재자',
  Protagonist:  '선도자',
  Campaigner:   '활동가',
  // 관리자 (Sentinels)
  Logistician:  '현실주의자',
  Defender:     '수호자',
  Executive:    '경영자',
  Consul:       '집정관',
  // 탐험가 (Explorers)
  Virtuoso:     '장인',
  Adventurer:   '모험가',
  Entrepreneur: '사업가',
  Entertainer:  '연예인',
  // 이미 한국어인 경우 (페이지가 한국어일 때)
  건축가: '건축가', 논리술사: '논리술사', 통솔자: '통솔자', 변론가: '변론가',
  옹호자: '옹호자', 중재자:   '중재자',   선도자: '선도자', 활동가: '활동가',
  현실주의자: '현실주의자', 수호자: '수호자', 경영자: '경영자', 집정관: '집정관',
  장인: '장인', 모험가: '모험가', 사업가: '사업가', 연예인: '연예인',
};

/** 특성 영어 이름 → 한국어 이름 */
const TRAIT_NAME_KO: Record<string, string> = {
  Extraverted:  '외향형', Introverted: '내향형',
  Intuitive:    '직관형', Observant:   '관찰형',
  Thinking:     '사고형', Feeling:     '감정형',
  Judging:      '계획형', Prospecting: '탐구형',
  Assertive:    '확신형', Turbulent:   '민감형',
  // 이미 한국어인 경우
  외향형: '외향형', 내향형: '내향형',
  직관형: '직관형', 관찰형: '관찰형',
  사고형: '사고형', 감정형: '감정형',
  계획형: '계획형', 탐구형: '탐구형',
  확신형: '확신형', 민감형: '민감형',
};

// ──────────────────────────────────────────────
// 결과 페이지: 성격 유형 문자열 추출
// h1 = "ENFJ-T" 또는 "ENFJ-T"
// title = "ENFJ Personality (Protagonist)" 또는 "ENFJ 성격 (선도자)"
// → "성격유형: ENFJ-T(선도자)"
// ──────────────────────────────────────────────
async function extractResultType(page: Page): Promise<string> {
  const typeCode = (
    await page.locator('h1').first().innerText({ timeout: 10_000 })
  ).trim().toUpperCase();

  const title     = await page.title();
  const nameMatch = title.match(/\(([^)]+)\)/);
  const rawName   = nameMatch ? nameMatch[1].trim() : '';

  // 영어 이름이면 한국어로 변환, 이미 한국어면 그대로 사용
  const koreanName = TYPE_NAME_KO[rawName] ?? rawName;

  return koreanName
    ? `성격유형: ${typeCode}(${koreanName})`
    : `성격유형: ${typeCode}`;
}

// ──────────────────────────────────────────────
// 결과 페이지: 성격 특성 비율 문자열 추출
// 영어: "58% Extraverted" → 한국어: "외향형 – 58%"
// 한국어: "58% 외향형"   → 한국어: "외향형 – 58%"
// ──────────────────────────────────────────────
async function extractTraits(page: Page): Promise<string> {
  const texts = await page.locator('.traitbar__inner').allInnerTexts();

  return texts
    .map((t) => {
      const m = t.trim().match(/^(\d+)%\s+(.+)$/);
      if (!m) return null;
      const pct      = m[1];
      const rawTrait = m[2].trim();
      const koTrait  = TRAIT_NAME_KO[rawTrait] ?? rawTrait; // 영어면 한국어로 변환
      return `${koTrait} – ${pct}%`;
    })
    .filter((v): v is string => v !== null)
    .join(', ');
}

// ──────────────────────────────────────────────
// Cloudflare 챌린지 통과 대기
// "잠시만 기다리십시오…" 타이틀이 사라질 때까지 최대 60초 대기
// ──────────────────────────────────────────────
async function waitForCloudflare(page: Page): Promise<void> {
  const CF_TITLES = ['잠시만 기다리십시오', 'Just a moment', 'Please Wait'];
  const MAX_WAIT_MS = 60_000;
  const POLL_MS    = 1_000;
  const started    = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    const title = await page.title().catch(() => '');
    const isCF  = CF_TITLES.some(t => title.includes(t));

    if (!isCF) {
      logger.info(`Cloudflare 통과 완료 (${Date.now() - started}ms), 타이틀: "${title}"`);
      return;
    }

    logger.info(`Cloudflare 챌린지 대기 중… (${Date.now() - started}ms)`);
    await page.waitForTimeout(POLL_MS);
  }

  // 60초 후에도 통과 못하면 현재 상태로 진행 (다음 단계에서 오류 발생)
  logger.warn('Cloudflare 챌린지 60초 초과, 현재 상태로 진행');
}

// ──────────────────────────────────────────────
// 쿠키 / GDPR 동의 팝업 자동 닫기
// 없으면 조용히 넘어감
// ──────────────────────────────────────────────
async function dismissConsentBanners(page: Page): Promise<void> {
  const consentSelectors = [
    // 일반적인 쿠키 동의 버튼 패턴
    'button[id*="accept"]',
    'button[class*="accept"]',
    'button[id*="consent"]',
    'button[class*="consent"]',
    '[id*="cookie"] button',
    '[class*="cookie"] button',
    // 16personalities 특정 패턴
    '.sp-cookie-banner button',
    '.cookie-banner button',
    'button:has-text("동의")',
    'button:has-text("Accept")',
    'button:has-text("허용")',
  ];

  for (const selector of consentSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 1_500 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3_000 });
        logger.info(`동의 팝업 닫음: ${selector}`);
        await page.waitForTimeout(500);
        break;
      }
    } catch {
      // 해당 셀렉터 없음 → 다음 시도
    }
  }
}

// ──────────────────────────────────────────────
// 디버그 스크린샷 (문제 진단용, 오류가 아니어도 호출)
// ──────────────────────────────────────────────
async function captureDebug(
  page:          Page,
  screenshotDir: string,
  label:         string,
): Promise<void> {
  try {
    ensureDir(screenshotDir);
    const localPath = path.join(screenshotDir, `debug_${label}_${Date.now()}.png`);
    await page.screenshot({ path: localPath, fullPage: true });
    await saveScreenshot(localPath, `debug_${label}`);
    logger.info(`디버그 스크린샷 저장: debug_${label}`);
  } catch {
    logger.warn('디버그 스크린샷 저장 실패');
  }
}

// ──────────────────────────────────────────────
// 오류 스크린샷 저장 (로컬 → 필요 시 GCS 업로드)
// ──────────────────────────────────────────────
async function captureError(
  page:          Page,
  screenshotDir: string,
  label:         string,
): Promise<void> {
  try {
    ensureDir(screenshotDir);
    const localPath = path.join(screenshotDir, `error_${label}_${Date.now()}.png`);
    await page.screenshot({ path: localPath, fullPage: true });
    await saveScreenshot(localPath, label);
  } catch {
    logger.warn('스크린샷 저장 실패');
  }
}

// ──────────────────────────────────────────────
// 메인: Playwright로 테스트 수행
// ──────────────────────────────────────────────
export async function runTest(
  answers:       number[],
  screenshotDir: string,
  rowLabel:      string,
  headless       = true,
): Promise<TestResult> {
  if (answers.length !== TOTAL_QUESTIONS) {
    throw new Error(
      `답변 수 오류: 기대 ${TOTAL_QUESTIONS}개, 실제 ${answers.length}개`
    );
  }

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled', // 봇 감지 우회
      '--disable-infobars',
      '--window-size=1280,900',
    ],
  });
  const context = await browser.newContext({
    viewport:  { width: 1280, height: 900 },
    locale:    'ko-KR',
    // 실제 Chrome 브라우저처럼 보이도록 User-Agent 설정
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  // navigator.webdriver 속성 제거 (봇 감지 우회)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    // ── 페이지 로드 ──
    await page.goto(TEST_URL, { waitUntil: 'load', timeout: 45_000 });

    // ── Cloudflare 챌린지 통과 대기 ──
    // Cloud Run(데이터센터 IP)에서 접속 시 "잠시만 기다리십시오…" 페이지가 먼저 뜸
    // Playwright(실제 Chromium)는 자동 통과하지만 완료까지 최대 30초 대기 필요
    await waitForCloudflare(page);

    // ── 쿠키 / GDPR 동의 팝업 처리 ──
    await dismissConsentBanners(page);

    // ── 테스트 폼 로드 대기 (최대 30초) ──
    await page.locator('fieldset[class*="question"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });

    // ── 10 페이지 × 6 문항 처리 ──
    for (let pageNum = 0; pageNum < TOTAL_PAGES; pageNum++) {
      const startIdx = pageNum * QUESTIONS_PER_PAGE;

      // 현재 페이지 첫 fieldset 로드 대기 (여유 있게 30초)
      await page.waitForSelector('fieldset[class*="question"]', {
        timeout: 30_000,
      });

      const fieldsets = page.locator('fieldset[class*="question"]');
      const count     = await fieldsets.count();

      logger.row(
        parseInt(rowLabel.split('_')[0] ?? '0', 10),
        rowLabel.split('_').slice(1).join('_'),
        `페이지 ${pageNum + 1}/${TOTAL_PAGES}  문항 ${startIdx + 1}~${startIdx + count}`,
      );

      // 각 문항 라디오 클릭
      for (let i = 0; i < count; i++) {
        const answer = answers[startIdx + i];
        if (answer === undefined) break;

        const radioValue = toRadioValue(answer);
        await fieldsets
          .nth(i)
          .locator(`input[type="radio"][value="${radioValue}"]`)
          .click({ timeout: 8_000 });

        await page.waitForTimeout(80); // 애니메이션 대기
      }

      // 다음 / 제출 버튼 클릭
      const actionBtn = page.locator('button.button--action').first();
      await actionBtn.waitFor({ state: 'visible', timeout: 8_000 });
      await actionBtn.click({ timeout: 8_000 });

      // 마지막 페이지가 아니면 다음 페이지 첫 문항 등장 확인
      if (pageNum < TOTAL_PAGES - 1) {
        const nextFirstQ = startIdx + QUESTIONS_PER_PAGE + 1; // 1-based
        await page.waitForFunction(
          (expectedQ: number) => {
            const legend = document.querySelector(
              'fieldset[class*="question"] legend'
            );
            return (
              legend?.textContent?.includes(`질문 ${expectedQ}/60`) ?? false
            );
          },
          nextFirstQ,
          { timeout: 15_000 },
        );
      }
    }

    // ── 결과 페이지 도달 대기 ──
    await page.waitForURL(RESULT_URL_RE, { timeout: 30_000 });

    // 영어 결과 페이지로 리다이렉트된 경우 한국어 버전으로 강제 이동
    // 영어: https://www.16personalities.com/profile/enfj-t/x/abc123
    // 한국어: https://www.16personalities.com/ko/결과/enfj-t/x/abc123
    let resultUrl = page.url();
    if (!resultUrl.includes('/ko/')) {
      const koUrl = resultUrl.replace(
        /https:\/\/www\.16personalities\.com\/(profile\/)?/,
        'https://www.16personalities.com/ko/%EA%B2%B0%EA%B3%BC/'
      );
      logger.info(`영어 결과 페이지 감지 → 한국어로 이동: ${koUrl}`);
      await page.goto(koUrl, { waitUntil: 'load', timeout: 30_000 });
      await waitForCloudflare(page);
      resultUrl = page.url();
    }

    const resultType   = await extractResultType(page);
    const resultTraits = await extractTraits(page);

    return { resultType, resultTraits, resultUrl };
  } catch (err) {
    await captureError(page, screenshotDir, rowLabel);
    throw err;
  } finally {
    await browser.close();
  }
}
