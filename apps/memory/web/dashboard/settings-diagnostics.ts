import { apiFetch } from "./api-fetch";
import type { DoctorReport } from "../../src/server-internal/doctor";
import { renderRestartSection } from "./settings-restart-section";

const STAGE_LABELS: Record<string, string> = {
  db: "데이터베이스", embedder: "텍스트 임베딩 모델", vecConsistency: "텍스트 검색 색인",
  ftsConsistency: "글자 검색 색인", imageVecConsistency: "이미지 검색 색인",
  cleanup: "데이터 정리 작업", backup: "백업", disk: "저장 공간",
};

function paragraph(text: string, className = "document-processing-meta"): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

export function renderDoctorReport(report: DoctorReport): HTMLElement {
  const root = document.createElement("div");
  if (report.firstBlockingCause) {
    const cause = report.firstBlockingCause;
    const alert = document.createElement("div");
    alert.className = "memory-info-note";
    alert.setAttribute("role", "alert");
    alert.append(
      paragraph(`먼저 확인할 항목: ${STAGE_LABELS[cause.stage] ?? cause.stage}`, "document-processing-error"),
      paragraph(cause.problem), paragraph(`다음 조치: ${cause.fix}`),
    );
    root.append(alert);
  } else root.append(paragraph("이번 진단에서 막힌 단계가 없습니다."));
  const stages = document.createElement("ul");
  stages.className = "diagnostics-stages";
  for (const stage of report.stages) {
    const item = document.createElement("li");
    item.textContent = `${STAGE_LABELS[stage.name] ?? stage.name}: ${stage.healthy ? "정상" : "확인 필요"}${stage.detail ? ` — ${stage.detail}` : ""}`;
    stages.append(item);
  }
  root.append(stages, paragraph(`기억 ${report.counters.knowledgeNodes}개 · 텍스트 검색 색인 ${report.counters.vecNodes}개 · 글자 검색 색인 ${report.counters.ftsRows}개`));
  return root;
}

function isDoctorReport(value: unknown): value is DoctorReport {
  if (!value || typeof value !== "object") return false;
  const report = value as DoctorReport;
  const cause = report.firstBlockingCause;
  return Array.isArray(report.stages) && report.stages.length > 0
    && report.stages.every((stage) => stage && typeof stage.name === "string" && typeof stage.healthy === "boolean"
      && (stage.detail === undefined || typeof stage.detail === "string"))
    && (cause === null || Boolean(cause && typeof cause.stage === "string" && typeof cause.problem === "string" && typeof cause.fix === "string"))
    && Boolean(report.counters && [report.counters.knowledgeNodes, report.counters.vecNodes, report.counters.ftsRows]
      .every((count) => Number.isSafeInteger(count) && count >= 0));
}

export function renderConnectionDiagnostics(pageUrl = window.location.href): HTMLElement {
  const root = document.createElement("section");
  root.className = "connection-diagnostics";
  const title = document.createElement("h2");
  title.textContent = "연결·진단";
  root.append(title, paragraph("저장·검색·백업 상태를 확인하고 AI 앱의 연결을 준비합니다."));

  const doctorTitle = document.createElement("h3");
  doctorTitle.textContent = "메모리 상태 진단";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "diagnostics-refresh document-processing-submit";
  refresh.textContent = "다시 진단";
  const status = paragraph("", "document-processing-status");
  status.setAttribute("role", "status");
  const result = document.createElement("div");
  root.append(doctorTitle,
    paragraph("읽기 전용 진단입니다. 모델의 로드 상태와 색인·설정을 확인하며, 실제 추론 요청은 실행하지 않습니다. AI 제공자의 응답 여부는 이 결과로 확정할 수 없습니다."),
    refresh, status, result,
  );

  async function diagnose(): Promise<void> {
    refresh.disabled = true;
    result.replaceChildren();
    status.classList.remove("error");
    status.textContent = "진단 중...";
    try {
      const response = await apiFetch("/doctor");
      if (!response.ok) throw new Error(`진단을 불러오지 못했습니다 (HTTP ${response.status}). 연결 상태를 확인한 뒤 다시 진단하세요.`);
      const report = await response.json();
      if (!isDoctorReport(report)) throw new Error("진단 결과 형식을 확인할 수 없습니다. 다시 진단하세요.");
      result.append(renderDoctorReport(report));
      status.textContent = "진단 결과를 불러왔습니다.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "진단을 불러오지 못했습니다. 다시 진단하세요.";
      status.classList.add("error");
    } finally {
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", () => void diagnose());

  const mcp = document.createElement("section");
  mcp.className = "memory-info-note mcp-connection-help";
  const mcpTitle = document.createElement("h3");
  mcpTitle.textContent = "AI 앱 연결 (MCP)";
  const select = document.createElement("select");
  select.id = "mcp-client";
  for (const [value, text] of [["codex", "Codex"], ["claude-code", "Claude Code"]]) {
    const option = document.createElement("option");
    option.value = value!; option.textContent = text!; select.append(option);
  }
  const label = document.createElement("label");
  label.htmlFor = select.id;
  label.textContent = "연결할 AI 앱 ";
  label.append(select);
  const configCommand = document.createElement("pre");
  configCommand.className = "mcp-config-command";
  const checkCommand = document.createElement("pre");
  checkCommand.className = "mcp-check-command";
  const destination = paragraph("");
  mcp.append(mcpTitle, label,
    paragraph("AI 앱을 실행할 PC의 터미널에서 저장소의 apps/memory 폴더로 이동하세요. 서버에서 발급한 연결 토큰을 그 터미널의 BARA_MCP_TOKEN 환경 변수에 설정하고 같은 환경에서 AI 앱을 시작하세요. 토큰은 이 화면에 입력하지 않습니다."),
    paragraph("아래 명령은 토큰 값 없이 연결 설정 예시를 출력합니다. 출력한 설정을 해당 앱의 MCP 설정에 추가하세요."),
    configCommand, destination,
    paragraph("연결 확인은 도구 목록과 읽기 호출을 확인합니다. 기억을 추가하지 않습니다."), checkCommand,
  );
  function updateCommands(): void {
    try {
      const url = new URL(pageUrl);
      // Only the origin is used; never carry bootstrap fragments, credentials or queries.
      if (!["http:", "https:"].includes(url.protocol) || !/^[a-zA-Z0-9.:[\]-]+$/.test(url.host)) throw new Error("unsupported origin");
      const command = `bun run mcp:config --client ${select.value} --url '${url.origin}/mcp' --token-env BARA_MCP_TOKEN`;
      configCommand.textContent = command;
      checkCommand.textContent = `${command} --check`;
      destination.textContent = select.value === "codex"
        ? "Codex용 TOML 설정이 출력됩니다. bearer_token_env_var는 BARA_MCP_TOKEN을 참조합니다."
        : "Claude Code용 JSON 설정이 출력됩니다. Authorization은 BARA_MCP_TOKEN 환경 변수를 참조합니다.";
    } catch {
      configCommand.textContent = "HTTP(S) 서버 주소로 접속하면 연결 명령을 표시합니다.";
      checkCommand.textContent = "";
      destination.textContent = "";
    }
  }
  select.addEventListener("change", updateCommands);
  updateCommands();
  root.append(renderRestartSection(), mcp);
  void diagnose();
  return root;
}
