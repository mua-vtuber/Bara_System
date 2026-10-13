/**
 * server-internal/route-error-handler.ts — buildMemoryApi 가 app.onError 로 다는 오류 응답 한 곳(WP-B1-20U 설계 17.19
 * 설계 6 M1).
 *
 * 영구 삭제 통로(단건 삭제·메시지 삭제·/forget·휴지통 만료 등)는 주인 표가 가리키는 문서 기록이 documents 에 없으면
 * OwnedDocumentRecordMissingError 를 라우트 밖으로 던진다(외래 키를 끈 외부 도구가 DB 를 바꾼 경우뿐). Hono 기본 handler 는
 * 이 오류의 본문을 `Internal Server Error` 로 바꿔, 요청한 사람이 어느 기록이 어긋났는지 서버 로그를 열기 전에는 알 수
 * 없었다. 이 오류만 `err(c, 500, e.message)` 로 본문 error 에 기록 id 를 싣고 console.error 로 남긴다. 라우트마다 잡으면
 * 영구 삭제 통로 다섯 곳에 같은 코드가 늘어 이 한 곳에 둔다. 바깥 앱에 route("/", app) 으로 붙여도 Hono 가 이 앱의
 * handler 를 라우트마다 감싸 같은 본문이 나간다.
 *
 * 다른 오류는 Hono 기본 handler 와 같게 둔다: HTTPException 처럼 자기 응답을 가진 오류는 그 응답, 나머지는 console.error
 * 뒤 500 `Internal Server Error`.
 */

import type { ErrorHandler } from "hono";
import { OwnedDocumentRecordMissingError } from "../db/store-internal/asset-release.ts";
import { err } from "./http-helpers.ts";

export const routeErrorHandler: ErrorHandler = (error, c) => {
  if (error instanceof OwnedDocumentRecordMissingError) {
    console.error(error);
    return err(c, 500, error.message);
  }
  if ("getResponse" in error) {
    const res = error.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(error);
  return c.text("Internal Server Error", 500);
};
