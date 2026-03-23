/**
 * 16Personalities 자동화 — Apps Script 트리거 (Pub/Sub 방식)
 *
 * 구글폼 제출 시 Google Cloud Pub/Sub 토픽에 메시지를 발행합니다.
 * Mac의 로컬 서버가 Pub/Sub를 구독하여 즉시 테스트를 실행합니다.
 * → Mac에 공개 URL 불필요 (Mac이 클라우드에 먼저 연결해서 대기)
 *
 * [설치 방법]
 * 1. 구글 시트 → 확장 프로그램 → Apps Script
 * 2. 이 코드 전체 붙여넣기 후 저장 (Ctrl+S)
 * 3. 왼쪽 톱니바퀴(프로젝트 설정) → "appsscript.json 파일 표시" 체크
 * 4. appsscript.json 에 아래 oauthScopes 추가:
 *    "oauthScopes": [
 *      "https://www.googleapis.com/auth/spreadsheets",
 *      "https://www.googleapis.com/auth/pubsub",
 *      "https://www.googleapis.com/auth/script.external_request"
 *    ]
 * 5. 트리거 → + 트리거 추가 → onFormSubmit / 양식 제출 시 → 저장
 * 6. 권한 허용
 */

var GCP_PROJECT_ID = 'personalities-automation';
var PUBSUB_TOPIC   = 'form-submissions';

// ──────────────────────────────────────────────
// 구글폼 제출 시 자동 실행
// ──────────────────────────────────────────────
function onFormSubmit(e) {
  try {
    var sheet     = e.range.getSheet();
    var rowNumber = e.range.getRow();
    var ss        = SpreadsheetApp.getActiveSpreadsheet();

    Logger.log('폼 제출 감지 → row ' + rowNumber);

    publishToPubSub({
      spreadsheetId: ss.getId(),
      rowNumber:     rowNumber
    });

    Logger.log('✅ Pub/Sub 발행 완료 (row ' + rowNumber + ')');

  } catch (err) {
    Logger.log('❌ 오류: ' + err.toString());
  }
}

// ──────────────────────────────────────────────
// 수동 테스트용 (Apps Script 편집기에서 직접 실행)
// ──────────────────────────────────────────────
function testManual() {
  var ROW_NUMBER = 2; // ← 테스트할 행 번호로 변경

  publishToPubSub({
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    rowNumber:     ROW_NUMBER
  });

  Logger.log('✅ 테스트 메시지 발행 완료 (row ' + ROW_NUMBER + ')');
}

// ──────────────────────────────────────────────
// Pub/Sub 메시지 발행 (내부 함수)
// ──────────────────────────────────────────────
function publishToPubSub(payload) {
  var url = 'https://pubsub.googleapis.com/v1/projects/'
    + GCP_PROJECT_ID + '/topics/' + PUBSUB_TOPIC + ':publish';

  var options = {
    method:             'POST',
    headers:            { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType:        'application/json',
    payload:            JSON.stringify({
      messages: [{ data: Utilities.base64Encode(JSON.stringify(payload)) }]
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var text     = response.getContentText();

  Logger.log('Pub/Sub 응답 ' + code + ': ' + text);

  if (code !== 200) {
    throw new Error('Pub/Sub 발행 실패 (' + code + '): ' + text);
  }
}
