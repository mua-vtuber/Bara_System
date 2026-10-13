export interface LauncherState {
  needsSetup: boolean;
  running: boolean;
  pid?: number;
  busy: boolean;
  progress: string;
  error: string;
  /**
   * WP-B2-06R — true 면 이전에 완료된 설정 파일이 남아 있어(재준비 트리거는
   * 마커 형식 문제일 뿐 사용자가 AI를 새로 고르길 원한 게 아닐 수 있음) "현재
   * AI 설정 유지" 버튼을 보여줄 수 있다. 최초 설치(설정 파일 없음)는 유지할
   * 값이 없으므로 false.
   */
  hasExistingSettings: boolean;
}

export function launcherView(state: LauncherState) {
  return {
    status: state.busy ? state.progress : state.needsSetup ? "초기 준비가 필요합니다. 아래에서 AI 사용 방식을 선택하세요."
      : state.running ? `서버 실행 중${state.pid ? ` · PID ${state.pid}` : ""}` : "서버 정지됨 · 대시보드 열기를 누르면 시작합니다.",
    error: state.error,
    setupDisabled: state.busy,
    openDisabled: state.busy || state.needsSetup,
    // WP-B2-06R — keep-current button only makes sense while setup is needed
    // AND a previous settings file exists to keep.
    keepCurrentVisible: state.needsSetup && state.hasExistingSettings,
  };
}
