import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

/**
 * 실패 스크린샷 저장
 *
 * - GCS_BUCKET 환경변수가 설정되어 있으면 → Google Cloud Storage 업로드 후 gs:// URL 반환
 * - 미설정이면 → 로컬 파일 경로 그대로 반환 (로컬 개발용)
 *
 * @param localPath  이미 로컬에 저장된 PNG 파일 절대 경로
 * @param label      파일명에 쓸 식별자 (예: "5_홍길동")
 * @returns          저장된 위치 (gs://... 또는 로컬 경로), 실패 시 null
 */
export async function saveScreenshot(
  localPath: string,
  label:     string,
): Promise<string | null> {
  const bucket = process.env['GCS_BUCKET']?.trim();

  // ── 로컬 저장만 (GCS 미설정) ──────────────────
  if (!bucket) {
    logger.warn(`스크린샷 로컬 저장: ${localPath}`);
    return localPath;
  }

  // ── GCS 업로드 ────────────────────────────────
  try {
    // @google-cloud/storage 를 동적 import 해서 미설치 시 런타임 오류 방지
    const { Storage } = await import('@google-cloud/storage');

    const keyFile     = process.env['GOOGLE_KEY_FILE'];
    const resolvedKey = keyFile ? path.resolve(keyFile) : null;
    const useKeyFile  = resolvedKey !== null && fs.existsSync(resolvedKey);

    const storage = new Storage(
      useKeyFile ? { keyFilename: resolvedKey! } : {}
    );

    const destFileName = `screenshots/error_${label}_${Date.now()}.png`;
    await storage.bucket(bucket).upload(localPath, { destination: destFileName });

    const gcsUrl = `gs://${bucket}/${destFileName}`;
    logger.info(`스크린샷 GCS 업로드 완료: ${gcsUrl}`);
    return gcsUrl;
  } catch (err) {
    logger.warn('GCS 업로드 실패, 로컬 파일만 유지');
    logger.error('GCS 오류', err);
    return localPath;
  }
}

/** 로컬 디렉토리 생성 (없으면 만들기) */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
