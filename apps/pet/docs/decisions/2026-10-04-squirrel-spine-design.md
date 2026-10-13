# 날다람쥐 Spine 캐릭터로 펫 교체 설계

작성일: 2026-10-04

후속 사용자 결정(2026-10-04): 펫을 누르면 입력창 안에서 입력·질문을 선택할 수 있으므로 펫 아래 두 바로가기 버튼은 제거한다. 아래 U10·D7·O11의 버튼 겹침 결정은 이 변경으로 대체된다. 창과 캐릭터 크기는 유지하고, 기존 30px 띠는 발아래 동작을 담는 투명한 여백으로 남긴다. 클릭·드래그·우클릭 동작은 유지한다.

추가 사용자 결정(2026-10-04): 펫 재클릭 또는 입력창 바깥 클릭으로 입력창을 숨긴다. 초안과 입력창 내부의 입력·질문 전환은 유지한다. 펫→입력창·입력창→펫으로 초점이 옮겨지는 동안에는 두 창을 한 묶음으로 보고, 펫 클릭이 열린 상태를 토글한다. 그 밖으로 초점이 옮겨지면 숨긴다. 초점을 받지 않는 말풍선의 닫기 버튼도 입력창을 숨긴다.

상태: 구현 전 설계안. 1절의 사용자 결정은 요구사항으로 다룬다. "설계자 기본값"이라고 표시한 값은 사용자가 확인하기 전의 임시 기본값이며, 14절 열린 항목에서 확인을 받는다. 같은 날 사용자가 O2·O6·O11·O14에 답해 1절 U10~U13과 14절에 반영했다. P1(움직임 규칙) 구현과 QA 뒤 같은 날 4.1·4.2·6.4·6.5·7.3·11·13절을 구현과 맞게 고쳤다(받아들인 해석, 카메라 거부 조건, 결정 D15). P2(렌더러·화면·빌드) 구현과 QA 뒤 같은 날 3.5·4.1·4.2·7.2·7.3·7.5·7.6·8·10·11·12절을 구현과 맞게 고쳤다(분할 결과 두 조각, 오류 코드 `CAMERA_LAYOUT`·`ASSET_MISSING`, 오류 카드와 알림 줄의 배치, 넓이 0 캔버스).

설계 당시 작업 사본: `<작업 사본>/.worktrees/bara-audit-fixes`, 브랜치 `feat/pet-squirrel`(당시 HEAD `21f31d03`). 2026-10-04 `18bd5d38`까지 메인에 병합했으며, 현재 실행·편집 위치는 `<작업 사본>/bara_system/apps/pet`이다. 이 문서의 경로는 `apps/pet` 기준이다.

## 0. 요약

- 펫 창의 SVG 새(`birdSvg`)를 WebGL 캔버스 하나로 바꾸고, `bara.json`의 날다람쥐를 Spine 런타임 4.3.13으로 그린다. 설정 창 머리글 그림은 이번 범위가 아니다.
- 움직임 규칙은 화면·WebGL과 분리한 순수 상태 기계(`MotionMachine`)가 정한다. 입력은 사건(피드백, 입력창 열림·닫힘, 마우스 활동, 동작 줄이기 설정, 창 보임)과 주입한 시계·난수이고, 출력은 "몸통 X 재생", "얼굴 Y를 더하기로 겹치기", "시작 연출 크기" 같은 명령 데이터다.
- 표정은 앱이 실제로 보낸 피드백(`pet-feedback`)만 따른다. `working` -> `think`, `saved` -> `cheer`+`smile`, 기억을 찾은 `answer` -> `cheer`+`smile`, 기억을 못 찾았거나 AI 답변이 실패한 `answer` -> 반응 없이 평소 모습, `error` -> `droop`+`side_eye`, 펫과 상호작용이 10분 없으면 `sleep`. 답변 결과는 문구를 비교하지 않고, 답변을 만드는 곳(`assistant.ts`)이 정하는 새 계약 값 `answerOutcome`(`found`·`notFound`·`aiFailed`)으로 구분한다. 같은 피드백 id에는 한 번만 반응한다(트레이 "최근 답변"이 같은 id로 다시 보내기 때문).
- 4.3.13에는 `MixBlend`가 없다. 사용자가 말한 `MixBlend.add`는 `TrackEntry.additive = true`로 구현한다.
- 고정 카메라는 실제 `bara.json`을 Bun에서 머리 없이 재생해 잰 모든 몸통 동작의 합친 범위로 정했다. 창 150x165는 그대로 두고, 캔버스가 창 전체를 덮으며 아래 30px는 발아래 동작을 담는 여백이다. 서 있는 키는 약 96px(지금 새 그림 약 100px)이고 창 가장자리에서 잘리는 동작은 없다.
- 입력창이 열렸는지 알기 위해 네이티브 호스트가 입력창을 보이고 숨길 때 새 이벤트 `pet-quick-visibility`(참·거짓)를 보낸다. 이벤트 이름은 `src/shared/native-host.json`의 `contract`에 한 번만 적는다.
- 그림 파일은 번들에 넣지 않고 `scripts/build-ui.ts`가 `dist/assets/squirrel/`에 복사한 뒤 `fetch`로 읽는다. Spine 런타임(압축 후 약 221KB)은 펫 창에서만 동적 `import()`로 불러오도록 코드 분할한다.
- WebGL이 없거나 파일을 읽지 못하면 펫 창에 원인을 적은 오류 카드가 보이고, 펫 버튼은 그대로 입력창을 연다. 예전 새 그림으로 되돌아가지 않는다.
- 튜닝 값(상태별 동작 이름, 얼굴 동작 묶음, 겹치기 방식, 섞는 시간, 무작위 간격, 잠드는 시간, 시작 연출 길이·시작 크기, 카메라 범위)은 `src/ui/squirrel/motion-config.ts` 한 곳에 둔다.
- 구현은 네 묶음이다. P3 네이티브·브리지(`sonnet`)와, P4 답변 결과 계약(`sonnet`) -> P1 순수 움직임 규칙(`opus`) 흐름을 함께 진행하고, 그 다음 P2 렌더러·화면·빌드(`opus`)를 진행한다. P4는 지금 같은 브랜치에서 진행 중인 `classificationFailureReason` 수정 커밋 뒤에 시작한다(같은 파일을 고침).

## 1. 사용자 결정 (요구사항)

| 번호 | 결정 |
|---|---|
| U1 | 표정은 앱의 실제 상태만 보여준다. AI 모델이 고르는 표정은 없다. 화남·슬픔 표정은 없다. |
| U2 | 평소 = `idle`, 찾는 중·작업 중 = `think`(결과가 올 때까지 반복), 저장 확인 또는 답변 도착 = `cheer`+`smile`, 요청 실패 = `droop`+`side_eye`, 오래 활동 없음 = `sleep`. (답변 도착은 아래 U12와 O18로 "기억을 찾은 답변"에만 좁혔다.) |
| U3 | `idle` 중에는 `blink`·`ear_flap`·`nose_wiggle`·`smile`을 무작위 간격으로 겹친다. `think` 중에는 `blink`·`ear_flap`만 겹친다. 잠자는 동안과 `jump`·`glide`·`cling`·`land` 중에는 얼굴 동작이 없다. |
| U4 | `ear_flap`·`nose_wiggle`·`smile`은 더하기로 겹쳐 숨쉬기를 살리고, `side_eye`는 덮어쓰기로 겹쳐 만든 표정 그대로 보인다. 얼굴 동작은 짧게 섞어 들어오고 나가서 귀·볼이 튀지 않는다. |
| U5 | 앱 시작: 창 위쪽에서 작게 시작해 다가오듯 커지며 `glide`를 반복하다가 `cling` -> `land` -> `idle`. 창은 움직이지 않는다. OS의 동작 줄이기가 켜져 있으면 바로 `idle`. 시작 연출은 "연결됨" 신호가 아니다. |
| U6 | 클릭 반응 동작은 없다. 왼쪽 클릭은 입력창(`open_quick`)을 열고, 끌면 창이 움직이고, 오른쪽 클릭은 설정을 연다. 대신 `jump` -> `cling` -> `land` -> `idle`을 평소 상태에서만 무작위로 재생한다. 입력창이 열렸을 때, 생각 중, 잠자는 중, 동작 줄이기 중에는 하지 않는다. 실제 상태 변화(피드백)가 오면 즉시 끊는다. 무작위 연출 때문에 실제 상태 표시가 늦어지지 않는다. |
| U7 | 허용 전환: `jump` -> `glide` 또는 `cling`, `glide`·`cling` -> `land`, `jump` -> `land`(제자리 점프). |
| U8 | 연결 실패가 이어지는 상태, "찾은 기억 없음" 동작, 잠들기·깨기 동작은 정하지 않았다. 이번 범위가 아니며 열린 항목에만 적는다. |
| U9 | 튜닝 값은 설정 모듈 한 곳에 둔다. |
| U10 | (2026-10-04 추가, O11) 창 크기는 150x165 그대로, 배치 B(캔버스가 창 전체, 아래 띠에 바로가기 버튼이 겹침). |
| U11 | (2026-10-04 추가, O6) 펫과의 상호작용이 10분 없으면 잠든다(설계자 기본값을 확정). |
| U12 | (2026-10-04 추가, O2) 질문해서 기억을 하나도 찾지 못하면 반응하지 않는다. `think`가 끝나면 바로 `idle`로 돌아간다. 말풍선이 이미 "찾지 못했다"고 알린다. U8의 "찾은 기억 없음 동작"은 이 결정으로 닫는다. |
| U13 | (2026-10-04 추가, O14) 사용자는 유료 Spine Editor 라이선스를 갖고 있다. Spine 쪽 조건은 라이선스·저작권 문구를 함께 배포하는 것으로 충족된다. 남은 것은 AGPL로 받는 사람에게 일관된지(추가 허가 문구)이고, 메인 세션이 사용자와 따로 정한다. |

AI 답변이 실패한 질문(`aiFailed`)도 반응하지 않는 것은 메인 세션이 정한 기본값이며 사용자 확인 전이다(O18). 말풍선이 "AI 답변을 만들지 못했다"고 알리는 동안 기뻐하면 신호가 엇갈리기 때문이다.

## 2. 범위

### 포함

- 펫 창(`index.html?view=pet`)의 캐릭터를 Spine 날다람쥐로 교체: 불러오기, 그리기, U2~U6의 움직임 규칙, 오류 화면.
- 입력창 열림·닫힘을 펫 창에 알리는 네이티브 이벤트(U6의 "입력창이 열렸을 때"를 지키는 데 필요).
- 답변 결과 계약 값 `answerOutcome`(U12와 O18을 지키는 데 필요, 9.1절): `Answer`·`Feedback` 타입, `assistant.ts`, `answerFeedback`, `quick.ts`, Rust `Feedback`.
- 빌드: 그림 파일 복사, Spine 런타임 코드 분할, Spine 런타임 라이선스 문서 복사(압축 빌드가 라이선스 주석을 지우는 것을 확인함, 3.5절).
- 함께 고치는 이전 후속 항목(결정 D10): 펫 창의 `open_quick`·`open_panel`·`startDragging` 실패를 화면에 보이기(지금은 `void`로 버려짐), 펫 화면 CSS의 숫자 값을 토큰으로 옮기기.
- 테스트, 문서(`art/squirrel/README.md`의 "앱 연결은 아직 하지 않았다" 문장, `docs/status.md`) 갱신.

### 제외

- 설정 창 머리글(`main.ts:45` `brand-mark`)의 `birdSvg()`. 그대로 둔다(열린 항목 O4). 그래서 `src/ui/bird.ts`와 `.bird`·`.bird-eyes`·`.bird-body` CSS는 남는다.
- 펫 창 크기·위치 저장 방식 변경(결정 D7에서 창 크기를 유지하기로 함).
- 효과음, 먼지 효과 등 `takeoff`·`touchdown` 이벤트를 쓰는 연출(정해진 동작이 이 이벤트를 쓰지 않음, 결정 D6).

### 보류(사용자 결정 없음, U8)

- 연결 실패가 이어지는 상태 표시, 잠들기·깨기 동작. 14절 O1·O3. ("찾은 기억 없음"은 U12로 정해져 보류에서 뺐다.)

## 3. 확인한 사실과 근거

### 3.1 Spine 4.3.13 API (설치된 `node_modules/@esotericsoftware/spine-core|spine-webgl/dist/*.d.ts`와 `.js`를 읽어 확인)

| 용도 | 쓰는 API | 확인한 점 |
|---|---|---|
| 아틀라스 해석 | `new TextureAtlas(atlasText)`, `atlas.pages[i].name`, `page.pma`, `page.setTexture(texture)` | `setTexture`가 아틀라스의 `filter`(`MipMapLinearNearest,Linear`)로 `texture.setFilters`를 부르고, `GLTexture.setFilters`는 MipMap 필터면 `generateMipmap`을 부른다. 2048x512는 2의 거듭제곱이라 WebGL1에서도 밉맵이 된다. |
| 텍스처 | `new GLTexture(context, imageBitmap, page.pma)` | `GLTexture.update`가 `UNPACK_PREMULTIPLY_ALPHA_WEBGL`을 `!pma`로 둔다. `pma:true`라 값이 그대로 올라간다. 그림은 `createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })`로 만들어 브라우저가 알파를 다시 곱하거나 색을 바꾸지 않게 한다. |
| 뼈대 해석 | `new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(jsonText)` | `AtlasAttachmentLoader`의 두 번째 인자 `allowMissingRegions`를 넘기지 않는다(기본 false). 아틀라스에 없는 파츠는 예외가 되어 오류 화면으로 간다. |
| 동작 재생 | `new AnimationStateData(data)`의 `defaultMix`·`setMix(from, to, seconds)`, `new AnimationState(stateData)`, `setAnimation(track, name, loop)` | 몸통은 트랙 0, 얼굴은 트랙 1. |
| 더하기 겹침 | `TrackEntry.additive = true` | 4.3.13에는 `MixBlend`가 없다(`spine-webgl`을 Bun에서 import했을 때 `MixBlend`가 `undefined`). `additive`는 새 항목에 대해 다음 `apply` 전에만 설정할 수 있다. |
| 얼굴 섞어 넣기·빼기 | `setEmptyAnimation(1, 0)` -> `addAnimation(1, name, false, 0)`에 `entry.mixDuration = fadeIn` -> `addEmptyAnimation(1, fadeOut, 0)` | `addEmptyAnimation`의 `delay <= 0` 계산이 "앞 항목 길이 - fadeOut"이라 빠지는 섞기가 얼굴 동작 끝에 맞춰 끝난다. |
| 물리 | `skeleton.update(delta)` 후 `skeleton.updateWorldTransform(Physics.update)`. 불러온 직후 `setupPose()` + `updateWorldTransform(Physics.reset)` | `PhysicsConstraint.update`는 시간 차이(`delta`)를 제한하지 않고 20fps 단계(물리 제약 38개 모두 `fps: 20`)를 그만큼 반복한다. 그래서 앱이 프레임 간격을 잘라서 넘긴다(7.4절). |
| 범위 계산 | `skeleton.getBoundsRect()`(새 객체를 만듦), `getBounds(offset, size, temp)`(재사용) | 불러올 때 한 번과 테스트에서만 쓴다. |
| 이벤트 | `state.addListener({ event: (entry, event) => event.data.name })` | `jump`의 `takeoff`(0.73초), `land`의 `touchdown`(0.20초)이 데이터에 있다. 이번에 정한 동작은 쓰지 않는다(D6). |
| 그리기 | `new ManagedWebGLRenderingContext(canvas, attrs)`, `new SceneRenderer(canvas, context, false)`, `begin()`·`drawSkeleton(skeleton)`·`end()`, `resize(ResizeMode.Stretch)`, `camera`(`OrthoCamera`: `position`, `zoom`, `setViewport`) | `ManagedWebGLRenderingContext`는 WebGL을 얻지 못해도 예외 없이 `gl`이 `null`이 된다. 앱이 직접 확인해야 한다. `SkeletonRenderer`는 PMA 전용 혼합식(`srcRgbPma: GL_ONE`)만 쓴다. |
| 쓰지 않는 것 | `SpineCanvas`, `AssetManager` | `SpineCanvas`는 멈출 수 없는 자체 루프를 돈다. `AssetManager`의 `Downloader.finish`는 상태 코드 0을 성공으로 처리해(네트워크 오류도 상태 0) 빈 아틀라스가 성공처럼 넘어갈 수 있다. 원인을 정확히 보이려고 `fetch`로 직접 읽는다. |

### 3.2 데이터 사실 (`bara.json`)

- `slots`에 `dark` 색이 없다 -> 두 색 틴트(`twoColorTint`)를 끄고 정점 크기를 줄인다. 데이터에 나중에 생기면 검증이 막는다(5절 `render.twoColorTint`).
- 혼합 방식이 있는 슬롯은 `eye_shadow_L`·`eye_shadow_R`(`multiply`) 둘. 투명 배경 위로 나가면 검은 테두리가 생길 수 있어 실제 화면에서 확인한다(12절).
- 잘라내기(clipping) 첨부가 없어 그리기 중 `Float32Array` 생성이 일어나지 않는다.

얼굴 동작과 몸통 동작이 같은 속성에 키를 잡는 수(실제 JSON에서 계산, 속성 = 뼈 하나의 회전·이동·크기 중 하나 또는 슬롯 그림):

| 얼굴 동작 | 속성 수 | `idle`·`think`와 겹침 | `cheer`와 겹침 | `droop`와 겹침 | `jump`·`cling`·`land`와 겹침 |
|---|---|---|---|---|---|
| `blink` | 22(뼈 14개의 속성 21 + `head` 슬롯 그림 1) | 0 | 0 | 0 | 12 |
| `ear_flap` | 8 | 4(귀 회전) | 2 | 4 | 2~4 |
| `nose_wiggle` | 19 | 5(귀 회전, `head`·`head2`·`head3` 이동) | 3 | 5 | 3~8 |
| `smile` | 37 | 6 | 4 | 6 | 15~17 |
| `side_eye` | 38 | 7 | 5 | 7 | 18~22 |

4.3.13의 `AnimationState.from()`은 아래 트랙이 키를 잡지 않은 속성을 "기본 자세에서 섞기"(`SETUP`)로 처리한다. 그래서 더하기 트랙이 혼자 잡는 속성(눈·코 뼈)은 매 프레임 쌓이지 않는다(`getRelativeValue`가 `setup + value * alpha`를 돌려줌). 아래 트랙과 겹치는 속성(귀·볼)만 `current + value * alpha`로 숨쉬기 위에 더해진다. 4.2 이하에서 필요했던 "매 프레임 뼈를 기본 자세로 되돌리기"가 필요 없다.

### 3.3 몸통 동작 범위 측정

방법: 작업 사본 밖 임시 폴더의 일회용 스크립트(`measure-bounds.ts`, `probe-slots.ts`)가 Bun에서 `spine-core` 4.3.13으로 실제 `bara.json`·`bara.atlas`를 읽었다(텍스처 없이 아틀라스 영역 정보만). 기본 자세 + `Physics.reset`에서 시작해 1/60초 간격으로 `state.update` -> `state.apply` -> `skeleton.update` -> `updateWorldTransform(Physics.update)`를 돌리며 `getBoundsRect()`를 합쳤다. 반복 동작은 3바퀴, 한 번 동작은 길이 + 0.5초. 물리 시뮬레이션을 끈 `Physics.pose`로도 한 번 더 쟀다. 단위는 Spine 좌표(위가 +y, 발바닥 근처가 y=0).

| 동작 | 길이(초) | minX | maxX | minY | maxY | 가로 | 세로 | 끝을 정한 파츠 |
|---|---|---|---|---|---|---|---|---|
| 기본 자세 | - | -236.6 | 191.3 | -12.7 | 476.7 | 427.9 | 489.5 | |
| `idle` | 2.00 | -248.4 | 191.8 | -12.7 | 476.7 | 440.3 | 489.4 | 왼쪽 꼬리, 위 귀 |
| `think` | 6.27 | -286.7 | 209.0 | -12.7 | 492.7 | 495.7 | 505.4 | 꼬리, 귀 |
| `sleep` | 4.00 | -215.4 | 188.7 | -84.7 | 293.3 | 404.1 | 378.0 | 아래 `sleep_tail_B` |
| `cling` | 2.00 | -233.8 | 219.4 | -8.6 | 651.1 (pose 658.2) | 453.2 | 659.7 | 위 귀(유리에 붙어 높이 올라감) |
| `jump` | 1.00 | -240.6 | 238.3 | -23.7 | 631.3 | 478.9 | 655.0 | 위 귀, 아래 발 |
| `glide` | 0.67 | -219.4 | 221.1 | -8.1 | 419.6 | 440.5 | 427.7 | 양손 |
| `land` | 1.00 | -267.0 | 233.0 | -23.6 | 609.5 (pose 619.6) | 500.0 | 633.1 | 꼬리, 귀 |
| `cheer` | 1.33 | -267.0 | 205.3 | -12.7 | 481.1 | 472.3 | 493.8 | 꼬리 |
| `droop` | 2.00 | -308.4 | 191.8 | -12.7 | 476.7 | 500.3 | 489.4 | 처진 꼬리 |

이어 재생(섞기 0.2초): `glide`(2초)>`cling`>`land`>`idle`의 maxY 648.6(pose 657.3), `jump`>`cling`>`land`>`idle` 650.6(pose 657.6), `jump`>`glide`>`land`의 maxX 239.9, `idle`>`sleep` minY -84.7. 얼굴 동작을 겹친 경우(`idle`+4종, `think`+2종, `cheer`+`smile`, `droop`+`side_eye`)는 몸통 범위를 넘지 않았다.

합친 범위(두 물리 방식, 단독·이어 재생 모두): x -308.4 ~ 239.9, y -84.7 ~ 658.2 (가로 548.3, 세로 742.9). 여기에 사방 16단위 여유를 더한 값을 `view.contentBounds`로 쓴다: x -324.4 ~ 255.9, y -100.7 ~ 674.2. 여유 16단위(약 3px)는 실제 프레임 간격이 1/60초와 달라 물리 끝값이 조금 달라질 수 있어서 둔다(측정에서 물리 유무 차이가 최대 7.1단위였음).

### 3.4 Tauri 이벤트 전달 (tauri 2.11.6 소스, `@tauri-apps/api` 2.11.1)

- `Emitter::emit`은 어느 창 객체에서 불러도 "모든 대상"에 보낸다(`tauri-2.11.6/src/lib.rs:934`). 그래서 `overlay.rs:109`의 `quick.emit("pet-quick", mode)`도 입력창만이 아니라 모든 창에 간다. 의뢰서의 "입력창에만 보낸다"는 전제는 사실과 다르다. 다만 이 이벤트는 열릴 때만 있고 닫힐 때가 없어서 펫이 쓰기에 부족하다.
- JS `listen`의 기본 대상은 `Any`이고(`event.js:75`), `Any`로 등록한 듣기 함수는 `emit_to`의 대상 거르기와 상관없이 모든 이벤트를 받는다(`event/listener.rs:310` `match_any_or_filter`). `emit_to("pet", ...)`는 의도 표시일 뿐 다른 창의 기본 듣기 함수를 막지 못한다.
- 펫 창은 이미 `capabilities/app-events.json`으로 `core:event:allow-listen` 권한이 있다. 새 권한이 필요 없다.
- 입력창이 보이고 숨는 경로는 세 곳뿐이다: `overlay::open_quick`(보임), `overlay::hide_quick`(숨김, 지금은 입력창의 Esc와 보낸 직후 `quick.ts:92`·`quick.ts:118`에서 호출하고 권한상 `pet`·`main`도 부를 수 있음), `main.rs`의 `WindowEvent::CloseRequested`(입력창에서 Alt+F4 -> 숨김).

### 3.5 빌드 사실

- 지금 `dist/assets/main.js`는 105,685바이트이고 네 창(펫·설정·입력창·말풍선)이 모두 읽는다. Spine 런타임만 압축 번들하면 220,666바이트다. 정적 import하면 모든 창이 세 배 커진 파일을 읽는다.
- Bun 1.3.6에서 `splitting: true`로 시험 빌드하면 진입 파일 이름은 그대로 `main.js`·`main.css`이고 동적 import 대상은 `chunk-<hash>.js`로 나뉘며 `main.js` 기준 상대 경로로 불린다. `scripts/ui-entry.ts`의 치환 규칙은 바뀌지 않는다.
- 압축 결과에 "Spine Runtimes License" 문구가 남지 않는다(주석이 `/*!` 형식이 아님).
- (P2 구현 뒤 실제 빌드) 분할 결과는 조각 두 개다. 하나는 펫 창만 동적 import로 읽는 Spine 조각(약 240KB, `squirrel-runtime.ts`와 그 아래)이다. 다른 하나는 `main.js`와 Spine 조각이 함께 쓰는 모듈(`messages.ts`, `feedback-model.ts`, `squirrel-errors.ts`, `motion-config.ts` 등. 상태 기계가 `feedback-model.ts`의 `acceptFeedback`을 쓰기 때문)을 담은 공유 조각(약 60KB)이고, `main.js`가 정적 import한다. 그래서 네 창은 모두 `main.js`+공유 조각(114,543바이트)을 읽는다. 구현 전 `main.js`(P1 커밋 `fce4e1c6`에서 다시 잰 값 105,855바이트)보다 약 8% 많다.
- 압축은 클래스 이름을 바꾼다. `SkeletonJson` 같은 이름은 어느 출력에도 글자로 남지 않으므로, 빌드 확인은 압축 뒤에도 남는 Spine 고유 문자열(`Region not found in atlas`, `Animation not found`, `PolygonBatch is already drawing`)로 한다(12절 3번).
- `bara.json`은 404,773바이트, `bara.png` 612,958바이트, `bara.atlas` 3,418바이트.

### 3.6 답변 결과를 지금 피드백으로 알 수 없는 이유 (코드 읽기로 확인)

펫 창은 `Feedback`만 받는다. 지금 필드로는 U12와 O18을 지킬 수 없다.

- `src/service/assistant.ts` `ask`가 만드는 답변은 네 가지다.
  - 검색 결과 0건: `searchOnlyAnswer([])`. `text` = `noMemories`, `sources` = `[]`, `generated: false`.
  - AI 없이 찾음: `searchOnlyAnswer(memories)`. `text` = `foundMemories`, `sources` = 찾은 기억 전부, `generated: false`.
  - AI 답변: `generated: true`. AI 답변은 인용이 1개 이상일 때만 만들어진다. `parseGroundedAnswer`(`src/service/ai.ts`)가 비어 있는 `sourceIds`와 검색에 없던 id를 `AI_RESPONSE`로 거부하기 때문이다. `sources`는 AI가 인용한 일부(1개 이상)이고, 인용이 0개인 응답은 거부되어 아래 "AI 실패"가 된다.
  - AI 실패: `text` = `answerFailed(code)`, `sources` = 찾은 기억, `generated: false`.
- `src/ui/feedback-model.ts` `answerFeedback`은 답변의 서버 식별자가 요청 때와 다르면 `sources`를 `[]`로 비운다(`audience ? sources : []`). 그래서 `sources`가 비어 있어도 "못 찾음"이라는 뜻이 아니다.
- "AI 없이 찾음"과 "AI 실패"는 `generated: false`에 `sources`가 있다는 점까지 같다. 구분할 수 있는 것은 `text` 문구뿐인데, 문구 비교는 쓰지 않는다(문구가 바뀌면 조용히 틀어진다).
- 같은 피드백이 다시 방송되는 경로가 있다. 트레이 "최근 답변"(`tray.rs:51` -> `feedback::show_recent_answer`)과 명령 `show_last_feedback`(등록돼 있지만 지금 화면 코드에서 부르는 곳은 없음)이 저장해 둔 피드백을 같은 `id`, 새 `sequence`로 `present`해 `pet-feedback`을 다시 보낸다. `sequence` 검사만으로는 막히지 않아서, 예전 답변을 다시 열 때마다 캐릭터가 또 반응하게 된다.

## 4. 구조

### 4.1 파일 계획 (기능별 폴더 `src/ui/squirrel/`)

| 파일 | 책임 | 의존 | 묶음 | 예상 줄 |
|---|---|---|---|---|
| `motion-config.ts` | 모든 튜닝 값과 그 타입(5절). 상수 `SQUIRREL_MOTION`, 그리고 같은 정의에서 뽑은 이름 목록 `FACE_NAMES`·`REACTION_NAMES` | `contracts.ts`의 `AnswerOutcome`(`import type`) | P1 | 120 |
| `motion-types.ts` | 입력·명령·화면 연출 타입(`MotionCommand`, `Presentation`, `MotionFeedback`) | `contracts.ts`의 `AnswerOutcome`(`import type`, P4가 추가) | P1 | 50 |
| `motion-schedule.ts` | 순수 도우미: 가중치 무작위 선택, 간격 뽑기, 완화 곡선 표, 단계 끝 시각 계산, 설정이 쓰는 동작 이름 목록과 단계 쌍 | config | P1 | 100 |
| `motion-machine.ts` | 상태 기계 `MotionMachine`(6절) | config, types, schedule, errors(길이를 모르는 동작 이름은 `ANIMATION_MISSING`), `feedback-model.ts`의 `acceptFeedback` | P1 | 350 |
| `motion-validate.ts` | 설정의 동작 이름·전환·틴트를 `SkeletonData`와 대조, 동작 길이 표 `animationDurations(data)` | config, schedule(설정이 쓰는 동작 이름 목록, 단계 쌍), errors, Spine 타입(`import type`) | P1 | 90 |
| `squirrel-errors.ts` | `SquirrelError`(`code`, `detail`)와 코드 목록. 문구는 모름 | 없음 | P1 | 40 |
| `camera.ts` | 순수 계산: 고정 카메라 맞추기, 시작 연출 카메라 | 없음 | P1 | 80 |
| `test-utils/real-skeleton.ts` | 테스트 전용: 실제 `bara.atlas`·`bara.json`으로 `SkeletonData` 만들기. 같은 폴더의 `motion-fixtures.ts`(실제 동작 길이, 순서를 정한 난수 목록)도 테스트 전용 | Spine | P1 | 30 |
| `asset-paths.ts` | 그림 폴더(`assets/squirrel`)와 파일 이름 상수. 빌드 스크립트와 화면이 함께 씀 | 없음 | P2 | 15 |
| `squirrel-assets.ts` | `fetch`로 아틀라스·JSON·페이지 그림 읽기, 해석, 시간 제한(`AbortSignal.timeout`), 파일 대신 온 HTML 판별(`isPageInsteadOf`, 7.6절) | Spine, errors, asset-paths | P2 | 130 |
| `squirrel-renderer.ts` | WebGL 문맥, `SceneRenderer`, `Skeleton`, `AnimationState`, 명령 적용, 한 프레임 그리기, 크기·DPR, 문맥 잃음·복구, 카메라 배치 거부를 `CAMERA_LAYOUT`으로 | Spine, camera, config, errors | P2 | 230 |
| `frame-loop.ts` | `requestAnimationFrame` 루프 하나, 초당 상한, 숨김 정지, 간격 자르기, 움직임 시계 | config | P2 | 90 |
| `squirrel-runtime.ts` | 동적 import 진입점. assets + validate + renderer + machine + loop를 묶어 `SquirrelHandle`을 돌려줌 | 위 전부 | P2 | 150 |
| `squirrel-error-text.ts` | `SquirrelError` -> `messages.pet` 문구 | errors, messages | P2 | 40 |
| `pet-view.ts` | 펫 창 DOM(버튼, 캔버스, 오류 카드와 알림 줄을 담는 겹침 상자, 바로가기 버튼), 끌기·클릭·오른쪽 클릭과 실패 표시, 브리지 이벤트 연결, 동작 줄이기 감지, 런타임 동적 import | errors, error-text, bridge, messages, dom, pet-notice, config(`ui.commandNoticeMs`), `contracts.ts`(`ANSWER_OUTCOMES`) | P2 | 200 |
| `pet-notice.ts` | 알림 줄 규칙 `NoticeState`: 지나가는 알림(`command`, `contract`)과 남는 알림(`listen`), 명령 성공이 `command` 알림만 지움(8절) | 없음 | P2 | 40 |

함께 바뀌는 기존 파일: `src/ui/main.ts`(펫 분기 21~37행을 `renderPet(app)` 한 줄로), `src/ui/messages.ts`(`pet` 묶음), `src/ui/style.css`(펫 블록·토큰), `src/ui/bridge.ts`(`onQuickVisibility`), `src/shared/native-host.json`(`contract.quickVisibilityEvent`), `scripts/build-ui.ts`, 새 `scripts/ui-assets.ts`, Rust `overlay.rs`·`main.rs`·`native_host.rs`, `capabilities/app-events.json`(설명 문장만).

P4(답변 결과 계약, 9.1절)가 바꾸는 기존 파일: `src/shared/contracts.ts`(`ANSWER_OUTCOMES`, `AnswerOutcome`, `Answer.outcome`, `Feedback.answerOutcome`), `src/service/assistant.ts`, `src/ui/feedback-model.ts`(`answerFeedback`), `src/ui/quick.ts`(143행 호출), `src-tauri/src/feedback.rs`, 테스트 `tests/service-assistant.test.ts`·`tests/service-ai.test.ts`·`src/ui/feedback-model.test.ts`.

### 4.2 의존 방향 (한 방향, 거꾸로 참조 없음)

```
main.ts -> pet-view.ts -> (동적 import) squirrel-runtime.ts
pet-view.ts -> bridge.ts, messages.ts, dom.ts, squirrel-errors.ts, squirrel-error-text.ts, pet-notice.ts, motion-config.ts(ui.commandNoticeMs), contracts.ts(ANSWER_OUTCOMES)
squirrel-runtime.ts -> squirrel-assets.ts, squirrel-renderer.ts, frame-loop.ts, motion-machine.ts, motion-validate.ts
motion-machine.ts -> motion-schedule.ts, squirrel-errors.ts, feedback-model.ts(acceptFeedback), motion-config.ts·motion-types.ts(import type)
motion-validate.ts -> motion-schedule.ts, squirrel-errors.ts, motion-config.ts·@esotericsoftware/spine-webgl(import type)
motion-schedule.ts -> motion-config.ts
squirrel-renderer.ts -> camera.ts, squirrel-errors.ts, motion-config.ts·motion-types.ts(import type), @esotericsoftware/spine-webgl
scripts/ui-assets.ts -> src/ui/squirrel/asset-paths.ts, @esotericsoftware/spine-webgl(TextureAtlas로 페이지 이름 읽기)
```

- `motion-*`·`camera.ts`·`squirrel-errors.ts`는 DOM·WebGL·Spine 실행 코드를 import하지 않는다(`motion-validate.ts`는 `import type`만). 그래서 Bun 테스트에서 그대로 돈다.
- Spine은 `@esotericsoftware/spine-webgl`에서만 import한다. `spine-core`는 직접 의존성이 아니라 끌려 들어온 의존성이라 직접 import하지 않는다(`spine-webgl`이 `spine-core`를 전부 다시 내보냄).
- 펫 창 밖(설정·입력창·말풍선)은 Spine 코드를 읽지 않는다. `squirrel-runtime.ts`와 그 아래만 Spine 조각에 들어간다. `main.js`와 Spine 조각이 함께 쓰는 모듈은 빌드가 공유 조각으로 따로 빼고, 네 창이 모두 그것을 읽는다(3.5절).

### 4.3 화면 흐름

1. `main.ts`가 `view=pet`이면 `renderPet(app)`을 부른다.
2. `pet-view.ts`가 버튼·캔버스·바로가기 버튼을 만들고 클릭·끌기·오른쪽 클릭을 바로 연결한다(불러오기 전에도 입력창이 열린다).
3. `pet-feedback`과 `pet-quick-visibility` 듣기를 먼저 등록한 뒤 `import("./squirrel-runtime.ts")`를 부른다.
4. 런타임이 WebGL 문맥을 만들고 파일을 읽고 설정을 검증한다. 실패하면 `SquirrelError`를 던지고 `pet-view.ts`가 오류 카드를 보인다.
5. 성공하면 문서가 보이는 상태가 되는 첫 프레임에 `machine.start(now, reducedMotion)`를 부르고 루프를 돈다.
6. 브리지 이벤트와 마우스 활동은 `handle.feedback(...)` 등으로 들어가고, 상태 기계가 돌려준 명령을 그 자리에서 Spine에 적용한다(다음 프레임을 기다리지 않음).

## 5. 설정 모듈 `motion-config.ts`

`SQUIRREL_MOTION`(읽기 전용 객체) 하나에 모든 값을 둔다. "설계자 기본값"은 14절 O7·O12·O13에서 사용자 확인을 받는다.

| 키 | 기본값 | 뜻 | 출처 |
|---|---|---|---|
| `tracks.body` / `tracks.face` | `0` / `1` | 몸통·얼굴 트랙 번호 | 설계 |
| `states.idle` | `{ animation: "idle" }` (반복) | 평소 | U2 |
| `states.think` | `{ animation: "think" }` (반복) | 작업 중 | U2 |
| `states.sleep` | `{ animation: "sleep" }` (반복) | 잠 | U2 |
| `reactions.saved` | `{ body: "cheer", loops: 2, face: "smile" }` | 저장 확인. 유지 시간 = `loops` x 동작 길이(2.67초) | U2, 반복 수는 설계자 기본값 |
| `reactions.answerFound` | `{ body: "cheer", loops: 2, face: "smile" }` | 기억을 찾은 답변(AI 유무 상관없음) | U2, 설계자 기본값 |
| `reactions.error` | `{ body: "droop", loops: 3, face: "side_eye" }` | 실패(6.0초) | U2, 설계자 기본값 |
| `reactionFor` | `{ saved: "saved", error: "error", answer: { found: "answerFound", notFound: null, aiFailed: null } }` | 피드백 종류(답변은 `answerOutcome`까지)에서 반응 이름으로. `null` = 반응 없음 | U2, U12, O18 |
| `reactions.rememberIds` | `32` | 이미 반응한 피드백 id를 최근 몇 개까지 기억할지(같은 id 재방송에 다시 반응하지 않기, D14) | 설계 |
| `faces.blink` | `{ additive: false, fadeInSeconds: 0.08, fadeOutSeconds: 0.08 }` | 덮어쓰기. `idle`·`think`와 겹치는 키가 0개라 결과가 같고, 그림 교체·크기 키를 그대로 쓴다(D3) | 설계 |
| `faces.ear_flap` | `{ additive: true, 0.15, 0.2 }` | 더하기 | U4 |
| `faces.nose_wiggle` | `{ additive: true, 0.15, 0.2 }` | 더하기 | U4 |
| `faces.smile` | `{ additive: true, 0.15, 0.25 }` | 더하기 | U4 |
| `faces.side_eye` | `{ additive: false, 0.15, 0.25 }` | 덮어쓰기 | U4 |
| `randomFaces.idle` | `{ choices: [blink 3, ear_flap 1, nose_wiggle 1, smile 1], gapMs: [2000, 6000] }` | 이름 + 가중치, 끝난 뒤 다음까지 간격 | U3, 가중치·간격은 설계자 기본값 |
| `randomFaces.think` | `{ choices: [blink 3, ear_flap 1], gapMs: [2000, 6000] }` | | U3, 설계자 기본값 |
| `mix.defaultSeconds` | `0.2` | 몸통 동작 사이 섞기 | 설계자 기본값 |
| `mix.pairs` | `[]` | `{ from, to, seconds }` 예외 목록 | 설계 |
| `startup.flight` | `{ animation: "glide", durationMs: 1600, startScale: 0.3, startTopPx: 28, easing: "easeOutCubic" }` | 다가오는 비행: 크기 0.3 -> 1, 창 위에서 28px 지점 -> 제자리 | U5, 숫자는 설계자 기본값 |
| `startup.after` | `["cling", "land"]` | 비행 뒤 차례 | U5 |
| `startup.interruptReturnMs` | `200` | 시작 연출 중 실제 상태가 오면 제자리·제 크기로 돌아오는 시간 | 설계자 기본값(O9) |
| `show.steps` | `["jump", "cling", "land"]` | 무작위 연출, 끝나면 `idle` | U6 |
| `show.gapMs` | `[180000, 480000]` | 평소 상태에 들어간 뒤 3~8분 사이 무작위 | 설계자 기본값 |
| `transitions.allowed` | `jump>glide`, `jump>cling`, `jump>land`, `glide>land`, `cling>land`, `glide>cling` | `startup`·`show` 단계 사이 허용 목록. 마지막은 U5에서 온 것(O17) | U7, U5 |
| `sleep.afterMs` | `600000` | 펫과의 상호작용 없이 10분이면 잠 | U11 |
| `view.contentBounds` | `{ minX: -324.4, maxX: 255.9, minY: -100.7, maxY: 674.2 }` | 카메라가 늘 담아야 하는 Spine 좌표 범위(3.3절) | 측정 |
| `view.floorY` | `-12.7` | 서 있을 때 발바닥 높이. 이 선이 바로가기 띠 위에 온다 | 측정 |
| `frame.maxFps` | `30` | 그리기 상한 | 설계자 기본값(O12) |
| `frame.maxDeltaSeconds` | `0.1` | 한 프레임에 넘기는 최대 시간(물리 반복 폭주 방지) | 설계 |
| `load.timeoutMs` | `10000` | 파일 읽기·해석 시간 제한 | 설계자 기본값 |
| `render.twoColorTint` | `false` | 데이터에 어두운 색이 없음. 생기면 검증 실패 | 3.2절 |
| `render.contextAttributes` | `{ alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power" }` | `alpha`·`premultipliedAlpha`는 투명 창 합성을 위해 반드시 true | 설계 |
| `ui.commandNoticeMs` | `12000` | 펫 창 알림 줄 표시 시간(말풍선 오류 12초와 같은 길이) | 설계자 기본값 |

화면 레이아웃 값(바로가기 띠 높이 등)은 CSS 토큰이 원본이고 이 모듈에 두지 않는다(10절).

## 6. 상태 기계 `MotionMachine`

### 6.1 겉모습

```ts
type MotionCommand =
  | { type: "body"; animation: string; loop: boolean }
  | { type: "face"; animation: string; additive: boolean; fadeInSeconds: number; fadeOutSeconds: number }
  | { type: "faceClear"; fadeOutSeconds: number };
interface Presentation { scale: number; lift: number } // scale 1, lift 0 = 제자리. lift 1 = 시작 지점
// AnswerOutcome은 contracts.ts 한 곳에서 정의한다(P4). kind가 "answer"이면 answerOutcome이 반드시 있다.
type MotionFeedback =
  | { id: string; kind: "working" | "saved" | "error"; sequence?: number }
  | { id: string; kind: "answer"; answerOutcome: AnswerOutcome; sequence?: number };

class MotionMachine {
  constructor(config: MotionConfig, durations: Readonly<Record<string, number>>, random: () => number);
  start(now: number, reducedMotion: boolean): readonly MotionCommand[];
  tick(now: number): readonly MotionCommand[];
  feedback(now: number, feedback: MotionFeedback): readonly MotionCommand[];
  quickVisibility(now: number, visible: boolean): readonly MotionCommand[];
  activity(now: number): readonly MotionCommand[];
  reducedMotion(now: number, reduced: boolean): readonly MotionCommand[];
  visibility(now: number, visible: boolean): readonly MotionCommand[];
  presentation(now: number, out: Presentation): void;
}
```

- `now`는 밀리초 "움직임 시계"다. 루프가 잘라낸 프레임 간격을 더해 만들고, 창이 숨으면 멈춘다(6.8절). 상태 기계는 `Date.now()`·`performance.now()`·`Math.random()`을 직접 부르지 않는다.
- `durations`는 실제 `SkeletonData`에서 읽은 동작 길이(초)다. 숫자를 코드에 적지 않는다.
- 변화가 없으면 공유하는 빈 배열 상수를 돌려줘 매 프레임 배열을 만들지 않는다. `presentation`은 호출자가 준 객체에 값을 쓴다.
- 같은 몸통 동작을 이미 재생 중이면 `body` 명령을 다시 내지 않는다(`think` 진행 단계 피드백이 여러 번 와도 처음부터 다시 시작하지 않음). 반응(`cheer`·`droop`)은 처음 보는 결과 피드백 id마다 다시 시작한다. 이미 처리한 id에는 다시 반응하지 않는다(D14).

### 6.2 내부 상태

`mode`(`booting`·`startup`·`idle`·`show`·`think`·`reaction`·`sleep`), 시작 연출 단계와 끝 시각, 무작위 연출 단계와 끝 시각, 반응 종류와 끝 시각, 진행 중 피드백 id 묶음 `working`, 이미 결과를 처리한 피드백 id(최근 `reactions.rememberIds`개, 오래된 것부터 버림) `settledIds`, 마지막으로 받은 `sequence`, `quickOpen`, `reduced`, `visible`, `lastActivityAt`, `nextShowAt`, 얼굴 동작(이름, 끝 시각), `nextFaceAt`, 현재 몸통 동작 이름, 돌아오기 연출(시작 시각, 시작 크기·`lift`).

### 6.3 무엇을 보여줄지 정하는 순서 (위가 우선)

1. 시작 연출 진행 중이고 끊기지 않음 -> `startup`
2. 반응이 끝나지 않음 -> `reaction`
3. `working`이 비어 있지 않음 -> `think`
4. 무작위 연출 진행 중 -> `show`
5. 잠든 상태 -> `sleep`
6. 그 밖 -> `idle`

실제 상태(2, 3)는 장식 연출(1, 4)과 잠(5)을 언제나 이긴다. 다만 1이 2·3보다 위에 있는 것은 "끊기지 않았을 때"만이고, 피드백이 오면 시작 연출은 즉시 끊긴다(아래 표).

### 6.4 전이 표

| 입력 | 조건 | 결과 명령과 상태 |
|---|---|---|
| `start` | 동작 줄이기 켜짐 | `body idle`(반복), 화면 연출 없음, 얼굴 예약, 무작위 연출 예약하지 않음 |
| `start` | 꺼짐 | `startup`: `body glide`(반복), 비행 시작. 얼굴 없음 |
| `start` | 진행 중 작업이 있음(`start` 전에 `working`이 옴) | 비행을 건너뛰고 바로 `think`. 화면 연출 없음(실제 상태 우선, 6.3) |
| `start` 전(`booting`)의 모든 입력 | | 상태만 기억하고 명령은 내지 않는다. 진행 중 작업은 `working`에 더하고, 결과는 `working`에서 빼고 `settledIds`에 넣되 반응하지 않는다(아무도 보지 못한 결과를 늦게 보이지 않음, 숨김 창과 같음). 입력창·동작 줄이기·창 보임 값과 활동 시각도 기억한다 |
| `start` 전의 `tick`·`presentation`, 두 번째 `start` | | 오류를 던진다(연결 실수를 조용히 넘기지 않음) |
| `tick` | 비행 끝(`durationMs`) | `body cling`(한 번), 끝 = now + 길이 |
| `tick` | 시작 단계 끝 | 다음 단계(`land`) 또는 `idle`로. `idle` 진입 때 얼굴·무작위 연출 예약 |
| `feedback` `working` | `sequence`가 받아들여짐(아래 무시 행), 처음 보는 id | id를 `working`에 더함. 시작 연출·무작위 연출·잠·반응을 끊고 `think`(끊은 반응의 얼굴이 돌면 `faceClear`). 시작 연출을 끊었으면 돌아오기 연출. `activity`로 침 |
| `feedback` `working` | id가 이미 `working`에 있음(진행 중 작업의 반복 피드백, `show_last_feedback` 재방송) 또는 이미 `settledIds`에 있음(결과 뒤 늦게 온 작업 피드백) | 상태·반응 변화 없음. 활동으로만 침. 반복 피드백이 다른 결과의 반응을 끊지 않고, 끝난 작업이 `think`를 되살리지 않는다 |
| 결과 피드백(`saved`·`answer`·`error`) | id가 `settledIds`에 없음, `reactionFor`가 반응 이름을 줌(`saved`, `answer`+`found`, `error`), 창 보임 | id를 `working`에서 빼고 `settledIds`에 넣음. 반응 시작: `body cheer|droop`(반복), `face smile|side_eye`. 앞선 결과의 반응은 이 반응으로 바뀜(D15). 시작 연출·무작위 연출·잠을 끊음. 끝 = now + `loops` x 길이. 활동으로 침 |
| 결과 피드백 | id가 `settledIds`에 없음, `reactionFor`가 `null`(`answer`+`notFound`, `answer`+`aiFailed`) | id를 `working`에서 빼고 `settledIds`에 넣음. 반응 없음(U12, O18). 시작 연출·무작위 연출·잠을 끊고, 앞선 결과의 반응도 끝냄(D15, 그 반응 얼굴이 아직 돌면 `faceClear`). 우선순위대로: 다른 `working`이 있으면 `think`, 없으면 `idle`. 활동으로 침 |
| 결과 피드백 | id가 `settledIds`에 없음, 반응 이름이 있지만 창 숨김 | id를 `working`에서 빼고 `settledIds`에 넣음. 반응 없음(볼 사람이 없는 연출을 나중에 늦게 보이지 않음). 시작 연출·무작위 연출·잠을 끊고, 앞선 결과의 반응도 새 반응 없이 끝냄(D15, 반응 얼굴이 돌면 `faceClear`). 활동으로 침. 우선순위대로: 다른 `working`이 있으면 `think`, 없으면 `idle`(잠자던 펫도 `idle`로 깸). 다시 보여도 끝난 반응은 돌아오지 않는다 |
| 결과 피드백 | id가 이미 `settledIds`에 있음(트레이 "최근 답변" 같은 재방송) | 상태·반응 변화 없음. 활동으로만 침(사용자가 직접 연 것이므로 잠에서 깸) |
| `feedback` | `sequence`가 마지막보다 작음 | 무시. 같은 값은 받는다(`acceptFeedback`과 같은 규칙, 없으면 -1로 봄). 같은 값이 다시 와도 진행 중 id는 집합이고 결과는 `settledIds`가 막아 두 번 반응하지 않는다 |
| `tick` | 반응 끝 | `working`이 있으면 `think`, 없으면 `idle`. 반응 얼굴이 아직 돌면 새 상태에서 허용되지 않을 때 `faceClear` |
| `tick` | `idle`, now >= `nextShowAt`, 조건 충족 | `show`: `faceClear`, `body jump`. 조건 = 입력창 닫힘, 동작 줄이기 꺼짐, 창 보임, `working` 비어 있음, 반응 없음. 조건이 안 맞으면 now부터 다시 예약한다. 단 동작 줄이기 중이면 다시 예약하지 않고 예약을 멈춘다(`Infinity`, 동작 줄이기가 꺼질 때 새로 예약). 같은 프레임에 잠 조건도 맞으면 잠을 먼저 본다(아래 행) |
| `tick` | 무작위 연출 단계 끝 | 다음 단계(`cling`, `land`) 또는 `idle` |
| `tick` | `idle`, now - `lastActivityAt` >= `sleep.afterMs`, 입력창 닫힘 | `sleep`: `faceClear`, `body sleep`. 무작위 연출보다 먼저 판단한다: 같은 프레임에 둘 다 때가 되면 잠이 이기고 무작위 연출은 위 행대로 다시 예약된다. `think`·반응·연출 중에는 잠들지 않는다(6.3) |
| `quickVisibility(true)` | | `quickOpen = true`, 활동으로 침. 무작위 연출 중이면 즉시 `idle`. 잠자는 중이면 `idle` |
| `quickVisibility(false)` | | `quickOpen = false`, `lastActivityAt = now`, 무작위 연출을 now부터 다시 예약(동작 줄이기 중이면 예약하지 않음) |
| `activity` | 잠자는 중 | `idle`(깨기 동작은 U8에 따라 없음, 0.2초 섞기만). 활동 = 펫 창 위 마우스 움직임·누름, 피드백, 입력창 열림·닫힘(U11) |
| `activity` | 그 밖 | `lastActivityAt = now` |
| `reducedMotion(true)` | 시작 연출 중 | 즉시 제자리·제 크기(돌아오기 연출 없음), 우선순위대로 상태 결정 |
| `reducedMotion(true)` | 무작위 연출 중 | 즉시 `idle` |
| `reducedMotion(true)` | 그 밖 | 무작위 연출 예약은 지우지 않는다. 처음 때가 되면 조건이 맞지 않아 예약이 멈춘다(`Infinity`). 끝없이 다시 예약하지 않는다 |
| `reducedMotion(false)` | | 무작위 연출 예약 |
| `reducedMotion` | 지금과 같은 값 | 아무것도 하지 않음(예약을 다시 미루지 않음) |
| `visibility(false/true)` | | `visible` 값만 바꿈(시계는 루프가 멈춤) |

무작위 연출이 높은 곳(`cling`)에서 끊기면 바로 다음 상태로 0.2초 섞인다. 허용 전환 목록(U7)은 연출 단계 사이에만 적용하고, 실제 상태로 끊는 전환은 목록을 따지지 않는다(실제 상태가 우선).

### 6.5 얼굴 동작 예약

- `idle`과 `think`에 들어갈 때 `nextFaceAt = now + gapMs 범위의 무작위 값`.
- `tick`에서 얼굴이 돌고 있지 않고 now >= `nextFaceAt`이면 그 상태의 `choices`에서 가중치로 하나 고르고 `face` 명령(겹치기 방식·섞기 시간은 `faces.<name>`)을 낸다. 끝 시각 = now + 길이, 다음 예약 = 끝 + 간격.
- 상태가 바뀔 때 지금 얼굴이 새 상태에서 허용되지 않으면 `faceClear`(그 얼굴의 `fadeOutSeconds`). 예: `idle`에서 `smile` 중 `think`로 가면 `smile`을 뺀다. `ear_flap`은 두 상태 모두 허용이라 그대로 둔다.
- `sleep`·`startup`·`show`는 얼굴을 허용하지 않는다. 그래서 진입 때 얼굴이 돌고 있으면 그 얼굴의 `fadeOutSeconds`로 `faceClear`를 낸다. 얼굴이 돌고 있지 않으면 `faceClear`를 내지 않는다(뺄 얼굴도, 쓸 섞기 시간도 없음). 6.4 표의 `faceClear`도 이 뜻이다. 반응 중에는 반응 얼굴만 쓰고 무작위 얼굴은 예약하지 않는다(설계자 기본값, O8).
- 렌더러 적용(7.5절): 트랙 1이 비어 있으면 "빈 동작 -> 얼굴(섞어 들어옴) -> 빈 동작(섞어 나감)" 순서로 넣고, 다른 얼굴이 돌고 있으면 `setAnimation(1, ...)`로 바로 이어 섞는다. 이전 얼굴이 뚝 끊기지 않는다.

### 6.6 시작 연출과 화면 연출 값

- `presentation`: 비행 중에는 t = (now - 시작) / `durationMs`를 `easeOutCubic`(1 - (1 - t)^3)으로 바꿔 `scale = startScale + (1 - startScale) * e`, `lift = 1 - e`. 그 밖에는 `scale 1`, `lift 0`.
- 돌아오기 연출: 시작 연출이 피드백으로 끊기면 그 순간의 `scale`·`lift`에서 `(1, 0)`까지 `interruptReturnMs` 동안 직선으로 돌아온다. 동작 줄이기로 끊기면 즉시 `(1, 0)`.
- 상태 기계는 픽셀을 모른다. `lift`를 픽셀로 바꾸는 일은 `camera.ts`가 한다(7.3절).
- 시작 연출은 파일을 다 읽고 문서가 보이는 첫 프레임에 시작한다. 창이 숨은 채 만들어진 뒤 보이므로(`main.rs` setup의 `pet.show()`), 보이기 전에 연출이 지나가지 않게 한다.

### 6.7 동작 줄이기

- `matchMedia("(prefers-reduced-motion: reduce)")`의 값과 `change` 이벤트를 `reducedMotion` 입력으로 넣는다.
- 켜져 있으면 시작 연출을 건너뛰고(U5) 무작위 연출을 하지 않는다(U6). 몸통 상태 동작(숨쉬기, `think`, `cheer`, `droop`, `sleep`)과 얼굴 동작은 그대로 둔다. 상태 정보를 보여주는 움직임이기 때문이다(설계자 기본값, O10).

### 6.8 창이 숨었을 때와 시계

- 루프는 `document.visibilityState === "visible"`일 때만 돈다. 숨으면 `cancelAnimationFrame`, 다시 보이면 마지막 프레임 시각을 지금으로 다시 잡아 큰 간격이 생기지 않게 한다.
- 움직임 시계는 그린 프레임의 잘린 간격을 더한 값이라 숨은 동안 멈춘다. 그래서 숨기 직전의 점프는 다시 보일 때 그 자리에서 이어지고, 상태 기계와 Spine 재생 시각이 어긋나지 않는다. 잠드는 시간도 보이는 동안만 센다(U11로 정한 "펫과의 상호작용 10분 없음"을 보이는 동안 센다. 약점과 다른 안은 D12).
- 숨은 동안 온 피드백은 `working`만 갱신하고 반응은 건너뛴다(6.4절).
- WebView2가 Tauri의 창 숨김(`hide()`)을 `document.hidden`으로 알려주는지는 소스로 확인하지 못했다. 실제 앱에서 확인하고, 알려주지 않으면 숨긴 펫 창도 계속 그린다는 뜻이므로 후속으로 네이티브 보임 이벤트를 더한다(O15).
- 2026-10-07 (실행 계획 1C①): 소스 확인 결과 Tauri의 창 숨김은 WebView2의 `IsVisible`을 바꾸지 않아 페이지는 계속 "visible"이다. 그래서 호스트가 펫을 숨기거나 보일 때 WebView도 함께 숨기고(`IsVisible`) 펫 창에 `contract.petVisibilityEvent`를 보내며, 페이지는 로드 때 `get_pet_visible`로 현재 상태를 묻는다. 루프는 이 신호와 `document.visibilityState`가 모두 보임일 때만 돈다(`frame-loop.ts` `setVisible`, `pet-presence.ts`). 트레이로만 시작하면 첫 표시 때까지 WebGL 문맥과 Spine 파일을 만들지 않는다. status.md "단계 1C① 숨긴 펫 그리기 중단" 참고.

## 7. 렌더러

### 7.1 캔버스와 WebGL 문맥

- 캔버스 하나가 펫 버튼 전체(창 150x165 CSS px)를 덮는다. `pointer-events: none`이라 클릭·끌기는 버튼이 받는다. `aria-hidden="true"`.
- `new ManagedWebGLRenderingContext(canvas, config.render.contextAttributes)` 뒤 `context.gl`이 `null`이면 `SquirrelError("WEBGL_UNAVAILABLE")`. `failIfMajorPerformanceCaveat`는 켜지 않는다(소프트웨어 WebGL이라도 그릴 수 있으면 그린다).
- `new SceneRenderer(canvas, context, config.render.twoColorTint)`.
- 매 프레임 `gl.clearColor(0, 0, 0, 0)`·`gl.clear(gl.COLOR_BUFFER_BIT)` 뒤 `begin()` -> `drawSkeleton(skeleton)` -> `end()`. 그림 데이터가 PMA이고 런타임이 PMA 혼합만 쓰므로 투명 창 위에서 테두리가 비치지 않는다.

### 7.2 DPR

- 창 `resize` 이벤트와 `matchMedia("(resolution: <현재 dpr>dppx)")`의 `change`(모니터 사이 이동)를 들을 때마다 `renderer.resize(ResizeMode.Stretch)`(캔버스 내부 크기 = CSS 크기 x DPR, 그래픽 장치 한도로 제한, `gl.viewport` 전체)를 부르고 카메라를 다시 계산한다. 매 프레임에는 하지 않는다.
- 2048x512 아틀라스를 약 0.2~0.4배로 줄여 그리므로 밉맵이 꼭 필요하다(3.1절에서 자동 생성 확인).
- 캔버스의 CSS 넓이가 0이면(창 최소화, 배치 전에 열린 미리보기 탭) 그릴 곳이 없으므로 카메라를 맞추지 않고 그리기만 쉰다(애니메이션·물리 시간은 루프대로 흐름). 다음 `resize`에서 넓이가 생기면 다시 맞추고 그린다. 넓이 0을 7.3절 거부로 다루면 잠깐의 상태가 영구 오류 카드가 되기 때문이다. 넓이가 있는데 띠가 너무 낮은 배치는 그대로 거부한다.

### 7.3 고정 카메라 (측정값으로 정함)

`camera.ts`의 순수 함수 두 개:

- `fitCamera({ cssWidth, cssHeight, bandPx }, contentBounds, floorY)`: 1 Spine 단위당 CSS px `s = min(cssWidth / 범위가로, (cssHeight - bandPx) / (maxY - floorY))`. 발바닥 선(`floorY`)을 띠 위 끝에 맞추고 가로는 범위 가운데에 맞춘다. 결과는 보이는 Spine 좌표 사각형과 `s`. 발바닥 선 아래(잠잘 때 꼬리, 웅크린 발끝)는 띠 높이 안에만 들어갈 수 있으므로 `(floorY - minY) x s > bandPx`이면 그 숫자들을 담은 `RangeError`(하위 클래스 `CameraLayoutError`, 필요한 px `neededPx`와 띠 px `availablePx`를 담음)로 거부한다. 렌더러는 이것을 오류 카드 `CAMERA_LAYOUT`으로 보이고 영어 문장은 콘솔에만 남긴다(8절). 조용히 잘라 그리지 않는다. 캔버스 넓이 0은 렌더러가 이 함수를 부르기 전에 걸러 그리기를 쉰다(7.2절). 처음 적었던 셋째 항 `cssHeight / 범위세로`는 발바닥 선을 띠 위에 고정한 뒤에는 아래쪽을 보장하지 못해 뺐다(배치 B 숫자는 그대로다. 그 항이 B를 정한 적이 없음). 150x165 창에서는 띠가 약 18.7px 이상이어야 하고, 띠 30px에서 발바닥 선 아래는 17.3px를 쓴다.
- `presentCamera(base, anchor, presentation, startPoint, out)`: 시작 연출 크기 `k`와 `lift`를 받아, 기준점 A가 화면의 "제자리 위치 + lift x (시작 지점 - 제자리 위치)"에 오도록 `camera.zoom = 1 / k`, `camera.position`을 계산해 `out`에 쓴다. 물리는 카메라와 상관없으므로 크기가 바뀌어도 귀·비막이 흔들리지 않는다.
- 기준점 A = 불러올 때 기본 자세 범위의 가운데(약 x -22.6, y 232.0). 시작 지점 = (캔버스 가로 가운데, 위에서 `startTopPx`).
- `bandPx`는 캔버스의 computed style에서 읽은 CSS 토큰 `--pet-floor-inset`(30px) 값이다. 하단 버튼과 띠 요소는 없으며 카메라가 이 여백에 발아래 동작을 그린다.

창 150x165, 띠 30px일 때 값(테스트가 같은 계산을 확인한다):

| 항목 | 값 |
|---|---|
| 1단위당 CSS px | 0.19654 (높이 조건이 결정: (165 - 30) / (674.2 + 12.7)) |
| 보이는 Spine 범위 | x -415.9 ~ 347.4, y -165.3 ~ 674.2 |
| 발바닥 선 | 창 아래에서 30px |
| `idle` 키·너비 | 96.2px · 86.5px (DPR 1.5에서 144·130 장치 px) |
| `cling` 최고점(658.2) | 창 위 끝에서 3.1px 아래 |
| 띠에 가려지는 부분 | `sleep`의 꼬리 끝(발바닥 선 아래 14.2px까지), `jump`·`land` 웅크릴 때 발끝(2.2px) |

배치 안 비교:

| 안 | 창 | 캔버스 | 1단위당 px | `idle` 키 | 잘림·가림 |
|---|---|---|---|---|---|
| A 지금 배치 유지(버튼 140x133 + 아래 바로가기) | 150x165 | 140x133(띠 0) | - | - | 거부: 띠가 0이라 발바닥 선 아래(약 88단위)를 담을 곳이 없어 `fitCamera`가 `RangeError`를 낸다. 처음 적은 0.1716·84.0px·"잘림 없음"은 빠진 셋째 항으로 계산해 발바닥 선 아래 약 15px를 잘라 낸 값이었다 |
| B 결정(U10): 캔버스가 창 전체, 바로가기는 아래 띠에 겹침 | 150x165 | 150x165(띠 30) | 0.1965 | 96.2px | 잠잘 때 꼬리 끝·웅크린 발끝이 바로가기 뒤 |
| C 창 키우기 | 150x200 | 150x200(띠 30) | 0.2475 | 121.1px | B와 같음 |
| (참고) 제자리 동작만 담는 카메라 | 150x165 | 150x165(띠 30) | 0.2585 | 126.5px | `cling`에서 머리 위 약 38.6px가 창 밖으로 잘림(`jump`·`land`도 잘림). 버림 |

지금 새 그림의 몸통 높이는 약 100px(SVG 140x145 보기 영역을 140px로 그린 것 중 y 24~128)이라 B가 지금 크기와 가장 비슷하다.

### 7.4 프레임 루프 (`frame-loop.ts`)

```
frame(t):
  간격 = t - 지난 프레임; 간격 < 1000 / maxFps 이면 다음 rAF만 예약하고 끝
  delta = min(간격 / 1000, maxDeltaSeconds); 움직임 시계 += delta * 1000
  stage.apply(machine.tick(시계)); machine.presentation(시계, 재사용 객체)
  state.update(delta) -> state.apply(skeleton) -> skeleton.update(delta) -> skeleton.updateWorldTransform(Physics.update)
  카메라 계산(재사용 객체) -> 지우기 -> 그리기
  다음 rAF 예약
```

- `requestAnimationFrame` 루프는 하나뿐이다. 다른 타이머(`setTimeout`)를 쓰지 않는다. 얼굴·무작위 연출·잠 예약은 모두 `tick`에서 시계를 보고 판단한다.
- 프레임 안에서 예외가 나면 루프를 멈추고 `RENDER_FAILED` 오류 카드를 보인다. 조용히 다음 프레임을 계속하지 않는다.

### 7.5 명령 적용

| 명령 | Spine 호출 |
|---|---|
| `body` | `state.setAnimation(config.tracks.body, animation, loop)`. 섞기 시간은 `AnimationStateData`(`defaultMix` + `mix.pairs`의 `setMix`) |
| `face`, 트랙 1이 비었거나, 빈 동작만 남음(이전 얼굴을 다 빼서 `mixingFrom`이 없음) | `state.setEmptyAnimation(1, 0)`; `e = state.addAnimation(1, animation, false, 0)`; `e.additive = additive`; `e.setMixDuration(fadeIn, 0)`(대기열 항목이라 지연 시간을 새 섞기 시간으로 다시 계산); `state.addEmptyAnimation(1, fadeOut, 0)` |
| `face`, 다른 얼굴이 도는 중(빈 동작이 아직 이전 얼굴을 섞어 빼는 중인 것도 포함) | `e = state.setAnimation(1, animation, false)`; `e.additive`; `e.mixDuration = fadeIn`; `state.addEmptyAnimation(1, fadeOut, 0)` |
| `faceClear` | `state.setEmptyAnimation(1, fadeOutSeconds)` |

빼는 중인 얼굴도 "도는 얼굴"로 보는 이유: 그때 첫째 행처럼 `setEmptyAnimation(1, 0)`을 부르면 섞기 시간 0의 빈 동작이 빼던 얼굴을 그 자리에서 없앤다. 둘째 행은 빼던 얼굴에서 새 얼굴로 섞어 넘어가므로 6.5절의 "이전 얼굴이 뚝 끊기지 않는다"를 지킨다.

`blink`가 빠지는 섞기 중에는 `mixAttachmentThreshold`(기본 0) 때문에 그림 교체 키가 적용되지 않고 런타임이 기본 그림(`head`)으로 되돌린다. 그래서 잠들 때 깨어 있는 머리가 남지 않는다.

### 7.6 파일 읽기 (`squirrel-assets.ts`)

- 주소: `new URL("assets/squirrel/<파일>", document.baseURI)`. `asset-paths.ts`의 상수를 쓴다. 개발 서버(`scripts/dev.ts`)와 앱 모두 `dist/`를 제공하므로 같은 경로다.
- 순서: 아틀라스 글(`fetch` -> `response.ok` 확인 -> `text()`) -> `new TextureAtlas` -> 페이지마다 그림(`fetch` -> `blob()` -> `createImageBitmap`) -> `GLTexture` -> `page.setTexture` -> JSON 글 -> `SkeletonJson.readSkeletonData`.
- 실패마다 파일 이름을 담은 `SquirrelError`(8절). 전체를 `AbortSignal.timeout(load.timeoutMs)` 신호 하나로 묶어 멈춰 있지 않게 한다. `fetch`에는 그 신호를 넘기고, 끊을 수 없는 단계(`text()`·`blob()`·`createImageBitmap`)는 신호와 경주시켜 제한 시간이 지나면 `LOAD_TIMEOUT`이 된다.
- 성공 응답의 실제 본문이 HTML 문서로 시작하고 요청한 파일이 HTML이 아니면 `ASSET_MISSING`(파일 이름)을 던진다(`isPageInsteadOf`). 아틀라스·JSON은 읽은 본문을, 그림은 디코딩 전 앞 512바이트를 검사한다. Tauri는 정상 `.atlas`도 확장자를 몰라 `Content-Type: text/html`로 표시하므로 헤더만으로 파일 없음으로 판단하지 않는다(2026-10-04 실제 Tauri MIME 함수와 패키지 앱에서 재현·수정). 실제 없는 경로에는 `index.html`을 상태 200으로 돌려주므로, 이 본문 판별은 실제 HTML 대체 응답에 대한 파일 없음 안내를 유지한다.
- CSP: `fetch`는 `connect-src 'self'`, 같은 출처라 허용된다. `createImageBitmap`은 이미지 태그를 쓰지 않으므로 `img-src`와 상관없다. CSP 변경은 필요 없다.
- `ImageBitmap`은 닫지 않는다. 문맥을 잃었다 되찾을 때 `GLTexture.restore`가 다시 올린다.
- 문맥 잃음: 캔버스 `webglcontextlost` -> 루프 멈춤, `CONTEXT_LOST` 카드. `webglcontextrestored` -> `ManagedWebGLRenderingContext`가 텍스처·셰이더를 되살린 뒤 카드 숨김, 루프 재개.

## 8. 오류 상태와 문구

모든 문구는 `src/ui/messages.ts`의 새 `pet` 묶음에 둔다. 정확한 말투는 구현자가 기존 문구에 맞추고, 이 설계는 담을 정보만 정한다.

| 코드 | 감지 | 문구에 담을 정보 | 회복 |
|---|---|---|---|
| `WEBGL_UNAVAILABLE` | `context.gl === null` | 이 PC에서 캐릭터 그리기 기능(WebGL)을 쓸 수 없음, 그래픽 드라이버 확인 | 앱 재시작 |
| `ASSET_HTTP` | `!response.ok` | 파일 이름, HTTP 상태 | 재설치 안내 |
| `ASSET_NETWORK` | `fetch` 거부 | 파일 이름, 원인 | 재시작 |
| `IMAGE_DECODE` | `createImageBitmap` 거부 | 파일 이름 | 재설치 |
| `ASSET_PARSE` | `TextureAtlas`·`SkeletonJson` 예외 | 파일 이름, 원인 | 재설치 |
| `ANIMATION_MISSING` | 검증 | 설정의 동작 이름 | 개발자 수정 |
| `TRANSITION_NOT_ALLOWED` | 검증 | 앞·뒤 동작 이름 | 개발자 수정 |
| `DARK_TINT_DISABLED` | 검증(슬롯에 어두운 색이 생김) | 슬롯 이름 | 개발자 수정 |
| `LOAD_TIMEOUT` | 시간 제한 | 제한 초 | 재시작 |
| `MODULE_LOAD` | 동적 `import()` 거부 | 원인 | 재설치 |
| `CONTEXT_LOST` | `webglcontextlost` | 그래픽 장치가 다시 시작되어 잠시 그리지 못함 | 복구되면 자동으로 사라짐 |
| `RENDER_FAILED` | 프레임 예외 | 원인 | 재시작 |
| `CAMERA_LAYOUT` | `fitCamera`가 띠가 너무 낮다고 거부(`CameraLayoutError`, 7.3절) | 필요한 높이와 띠 높이(px, `필요 > 띠` 형식, 필요는 올림·띠는 내림해 맞는 것처럼 보이지 않게) | 개발자 수정 |
| `ASSET_MISSING` | 성공 응답이 HTML인데 요청한 파일은 HTML이 아님(7.6절) | 파일 이름, 앱이 그 파일 대신 화면 문서(HTML)를 돌려줬다는 사실 | 재설치 |

코드는 모두 14개다(`squirrel-errors.ts`의 `SQUIRREL_ERROR_CODES`, 테스트가 문구 목록과 대조). `ASSET_HTTP`(HTTP 상태)는 없는 파일에 404를 돌려주는 개발 서버(`scripts/dev.ts`)와 브라우저 미리보기에서 보이는 카드다. 실제 Tauri 앱은 없는 경로에 `index.html`(200)을 돌려주므로 앱에서 파일이 없으면 `ASSET_MISSING`이 보인다. 카메라 거부 가운데 "띠가 창 높이 이상"(`fitCamera`의 첫 검사)은 필요한 높이를 숫자 하나로 말할 수 없어 `RENDER_FAILED`로 남는다. 펫 창은 크기를 바꿀 수 없는 150x165라, CSS 띠가 165px 이상이 될 때만 생긴다.

오류 카드:

- 카드는 펫 버튼 안이 아니라 버튼 위에 겹친 형제 요소다. 알림 줄과 함께 겹침 상자(`.pet-overlay`, 띠 위 영역의 세로 줄)에 들어 있고 상자가 `pointer-events: none`이라, 카드 위를 눌러도 아래 버튼이 받는다. 버튼 안에 두면 버튼 내용이 보조기술에 표시용으로만 다뤄져 `role="alert"`가 읽히지 않기 때문이다.
- 제목(캐릭터를 표시하지 못함. 문구 "캐릭터를 못 그렸어요"는 띠 위 좁은 폭에서 한 줄에 들어가는 길이), 원인 문장, "눌러서 입력창 열기" 안내. 원인은 줄 수를 제한해 보인다. 카드가 마우스를 받지 않으므로 전체 문장은 버튼의 `title`(툴팁)과 `aria-describedby`로 읽는다. `role="alert"`. 카드가 보이는 동안 캔버스는 `visibility: hidden`(크기는 유지해 다음 `resize` 계산이 맞음).
- 알림 줄은 같은 상자의 위, 카드는 아래(`margin-top: auto`)에 붙는다. 둘이 함께 보이면 알림과 원인을 각각 2줄로 줄여 띠 위 높이(150x165에서 127px) 안에 둘 다 온전한 줄로 들어간다(겹치지 않음). 그래도 넘치는 경우를 위해 카드는 `min-height: 0; overflow: hidden`으로 줄어든다.
- 버튼의 클릭·끌기·오른쪽 클릭은 그대로 동작한다. 예전 새 그림이나 빈 캔버스로 대신하지 않는다.
- 브라우저 미리보기처럼 `native`가 false인 환경에서도 같은 카드가 나온다(그림 파일은 같은 경로로 읽히므로 정상이면 캐릭터가 나온다).

명령 실패 알림 줄(결정 D10):

- `open_quick`(펫 왼쪽 클릭), `open_panel`(오른쪽 클릭), `getCurrentWindow().startDragging()`이 거부되면 창 위쪽 알림 줄에 "입력창 열기를 끝내지 못했어요. 원인: <원인>" 같은 문장을 `errorMessage(error)`와 함께 보인다. 호스트는 창을 보인 뒤 포커스를 주고 모드를 알리므로(`overlay.rs` `open_quick`, `main.rs` `open_panel`) 거부가 창이 이미 뜬 뒤에 올 수 있다. 화면은 어느 단계에서 실패했는지 알 수 없으므로 "열지 못했다"가 아니라 "열기를 끝내지 못했다"고 쓴다. `ui.commandNoticeMs` 뒤 또는 다음 명령이 성공하면 사라진다. 펫 창은 `publish_feedback` 권한이 없고(`feedback.rs:235`), 실패 원인이 창 문제일 때 말풍선도 못 띄울 수 있어 펫 창 안에 보인다.
- 알림 종류와 규칙은 `pet-notice.ts`의 `NoticeState`가 정한다: 지나가는 알림 `command`(명령 실패, 다음 명령 성공 또는 12초 뒤 사라짐)와 `contract`(계약 위반, 12초 뒤), 남는 알림 `listen`(`pet-feedback`·`pet-quick-visibility` 듣기 등록 실패, 계속 남음). 지나가는 알림이 남는 알림을 잠시 덮고, 사라지면 남는 알림이 다시 보인다. 새 지나가는 알림은 앞의 것을 대신한다.
- 같은 알림 줄이 계약 위반도 보인다: `answer` 피드백에 `answerOutcome`이 없으면(호스트가 이미 거부했어야 하는 경우, 9.1절) 반응을 추측하지 않고 "답변 결과 신호가 없어 반응하지 않았어요" 취지의 `messages.pet` 문구를 보인다.

## 9. 네이티브·브리지 변경 (P3)

| 파일 | 변경 |
|---|---|
| `src/shared/native-host.json` | `contract.quickVisibilityEvent: "pet-quick-visibility"` 추가 |
| `src-tauri/src/native_host.rs` | `Contract`에 `quick_visibility_event: String`, 접근 함수 `pub fn quick_visibility_event() -> &'static str`. 테스트: 값이 비어 있지 않고 Tauri 이벤트 이름 글자(영숫자, `-`, `/`, `:`, `_`)만 씀 |
| `src-tauri/src/overlay.rs` | `pub fn announce_quick_visibility(app: &AppHandle, visible: bool) -> Result<(), HostError>`: `app.emit_to("pet", native_host::quick_visibility_event(), visible)`, 실패는 `HOST_WINDOW_OPERATION_FAILED`. `open_quick`은 `quick.show()`·`set_focus`·`pet-quick` 다음에 마지막으로 `true`를 보내고 오류를 `?`로 전달한다. `hide_quick`은 `hide()` 다음에, 보이는 말풍선을 다시 놓는 일(`position_near_pet`)과 `false` 알림을 서로 건너뛰지 않도록 둘 다 실행하고 먼저 난 오류를 돌려준다(말풍선 이동이 실패해도 펫이 입력창이 아직 열려 있다고 믿지 않게). 이 알림은 펫 창을 대상으로 보내지만 기본 대상으로 듣는 다른 창도 받는다(3.4절) |
| `src-tauri/src/main.rs` | `CloseRequested`에서 숨긴 창이 `quick`이면 `overlay::announce_quick_visibility(window.app_handle(), false)`. 이 콜백에는 오류를 보낼 화면이 없어 기존 `let _ = window.hide()`처럼 결과를 버린다. 실패하면 펫이 입력창을 열린 것으로 알고 있어 무작위 연출과 잠만 멈춘다(가짜 상태를 보이지는 않음) |
| `src-tauri/capabilities/app-events.json` | 권한은 그대로. `description`에 새 이벤트 이름만 더함 |
| `src/ui/bridge.ts` | `onQuickVisibility(callback: (visible: boolean) => void)`: `native`면 `listen<boolean>(nativeHost.contract.quickVisibilityEvent, ...)`, 아니면 기존 함수들처럼 아무것도 안 하는 해제 함수 |

- 처음 상태: 입력창은 `tauri.conf.json`에서 `visible: false`로 만들어지므로 펫은 "닫힘"에서 시작한다. 조회 명령은 만들지 않는다.
- 펫은 `pet-feedback`을 이미 받는다(전체 방송, `feedback.rs:205`). 쓰는 필드는 `id`, `kind`, `sequence`, 그리고 9.1절의 `answerOutcome`이다.
- 기존 이벤트 이름 네 개(`pet-feedback`, `pet-quick`, `pet-panel`, `pet-progress`)는 Rust와 TS에 글자로 남아 있다. 새 이벤트만 계약 파일로 옮기면 두 방식이 섞이지만, 새로 같은 글자를 두 곳에 적지 않는 쪽을 택했다. 네 개를 옮기는 일은 별도 정리 작업이다(O16).

### 9.1 답변 결과 계약 값 `answerOutcome` (P4)

3.6절 때문에 답변이 "기억을 찾음", "못 찾음", "AI 실패" 중 무엇인지를 피드백에 직접 싣는다. 값은 답변을 만드는 곳에서 정하고, 문구는 비교하지 않는다. 값 목록은 Rust와 TS가 함께 쓰므로 기존 `progressStages`와 같은 방식(`native-host.json`의 `contract` 목록 + TS `as const` 목록 + 둘을 대조하는 테스트)을 따른다.

| 파일 | 변경 |
|---|---|
| `src/shared/native-host.json` | `contract.answerOutcomes: ["found", "notFound", "aiFailed"]` |
| `src/shared/contracts.ts` | `export const ANSWER_OUTCOMES = ["found", "notFound", "aiFailed"] as const`, `export type AnswerOutcome`. `Answer`에 필수 필드 `outcome: AnswerOutcome`(필수라서 답변을 만드는 모든 곳이 타입 검사에서 걸림). `Feedback`에 선택 필드 `answerOutcome?: AnswerOutcome`(문서 주석: `kind: "answer"`에만 있고 반드시 있음) |
| `src/service/assistant.ts` | `searchOnlyAnswer`: `outcome: memories.length ? "found" : "notFound"`. AI 답변: `"found"`(이 시점에 찾은 기억이 1개 이상, AI가 인용한 수와 상관없음). AI 실패 `catch`: `"aiFailed"` |
| `src/ui/feedback-model.ts` | `answerFeedback(id, answer, sources, generated, outcome, audience?)`. `answerOutcome: outcome`를 서버 식별자 일치 여부와 상관없이 그대로 싣는다(출처만 비우는 기존 규칙은 유지) |
| `src/ui/quick.ts` | 143행 호출에 `answer.outcome`을 넘김 |
| `src-tauri/src/native_host.rs` | `Contract`에 `answer_outcomes: Vec<String>`, `pub fn is_answer_outcome(value: &str) -> bool`(`is_progress_stage`와 같은 모양) |
| `src-tauri/src/feedback.rs` | `Feedback`에 `#[serde(skip_serializing_if = "Option::is_none")] answer_outcome: Option<String>`. `parse_feedback` 구조 검사에 추가: `kind`가 `Answer`이면 값이 있어야 하고 `is_answer_outcome`이어야 함, 다른 `kind`이면 값이 없어야 함. 어기면 지금처럼 `"Feedback contains unsupported content"`로 거부. 값 길이는 목록에 있는 글자만 허용되므로 저절로 제한된다. `notify_host_error`의 구조체 생성에 `answer_outcome: None` |

- 펫 쪽(P1·P2): `MotionFeedback`은 `answer`일 때 `answerOutcome`이 필수인 타입이다(6.1절). P2의 `pet-view.ts`가 `Feedback`을 `MotionFeedback`으로 바꿀 때 `answer`에 값이 없으면, 호스트가 이미 거부했어야 하는 계약 위반이므로 반응을 추측하지 않고 펫 알림 줄에 계약 위반 문구(`messages.pet`)를 보인다.
- 트레이 "최근 답변"으로 다시 방송되는 피드백도 같은 `answerOutcome`을 그대로 가진다(Rust가 그대로 직렬화). 다시 반응하지 않는 것은 상태 기계의 `settledIds`가 맡는다(D14).
- 묶음과 모델: 작은 별도 묶음 P4, `sonnet`. 서비스·화면·Rust 세 층을 고치지만 정해진 모양을 옮기는 일이고, 판단이 필요한 부분(값의 뜻)은 이 절에서 정했다. P2에 넣지 않는 이유는 P2가 이미 크고, 이 변경은 말풍선·결과 화면에도 쓰일 수 있는 계약 변경이라 따로 검토·되돌리기 쉬워야 하기 때문이다.
- 순서: 같은 브랜치에서 진행 중인 `classificationFailureReason` 수정(`feedback.rs`, `feedback-model.ts`와 그 테스트를 고침)이 커밋된 뒤 시작한다. P1은 `AnswerOutcome` 타입을 import하므로 P4 뒤에 시작한다. P3와는 겹치는 파일이 `native-host.json`·`native_host.rs`뿐이라 P3가 먼저 끝나 있으면 그 위에 더한다.

## 10. CSS 변경 (P2)

- `:root`의 펫 토큰: `--pet-floor-inset: 30px`, `--pet-card-padding`, `--pet-card-radius`, `--pet-card-font-size`, `--pet-card-lines`, `--pet-notice-font-size` 등. 바로가기 전용 토큰은 제거한다. 색은 기존 토큰(`--line`, `--danger`, `--danger-pale`, `--muted-strong`, `--ink`)을 쓴다.
- `[data-surface=pet] #app`: `150px`·`165px` 대신 `100vw`·`100vh`, `position: relative`. 창 크기의 원본은 `tauri.conf.json` 하나가 된다.
- `.pet-button`: `position: absolute; inset: 0`(140x133 숫자 삭제).
- 새 `.pet-canvas`: `position: absolute; inset: 0; width: 100%; height: 100%; display: block; pointer-events: none`.
- `.pet-shortcuts`와 `.pet-shortcut` 요소·스타일은 제거한다. 오류 카드와 알림 줄의 아래쪽 여백도 `--pet-floor-inset`을 사용한다.
- `.pet-shortcut`: 숫자 값을 토큰으로.
- 새 `.pet-overlay`(알림 줄과 오류 카드를 담는 클릭 통과 세로 상자: 알림 `flex: none` 위, 카드 `margin-top: auto; min-height: 0; overflow: hidden` 아래), `.pet-error`(오류 카드), `.pet-notice`와 `.pet-notice-text`(알림 줄. 줄 수 제한은 안쪽 글 요소에만 걸어 다음 줄이 안쪽 여백으로 비치지 않게 함). 함께 보일 때의 줄 수는 `:has()`로 토큰 `--pet-card-lines-crowded`·`--pet-notice-lines-crowded`를 쓴다. 겹침 상자의 여백·간격은 `--pet-overlay-inset`·`--pet-overlay-gap`, 바로가기 그림자 길이는 `--pet-shortcut-shadow-y`·`--pet-shortcut-shadow-blur`.
- 삭제: `.pet-bird`, `.pet-button:hover .bird-body`. 남김: `.bird`, `.bird-eyes`, `.bird-body`, `.brand-mark .bird`(설정 창 머리글이 계속 씀).

## 11. 테스트 계획

가짜 Spine 뼈대·가짜 렌더러·가짜 브리지를 만들지 않는다. 상태 기계 입력(시각 숫자, 난수 숫자 목록, 피드백 객체)은 데이터 fixture이고, 동작 길이와 범위는 실제 `bara.json`에서 읽는다. `test-utils/real-skeleton.ts`는 실제 `TextureAtlas`·`AtlasAttachmentLoader`·`SkeletonJson` 클래스로 실제 파일을 읽는다. 텍스처는 올리지 않는데, 범위와 시간 계산에 텍스처가 쓰이지 않기 때문이다. 그리기는 빌드와 실제 브라우저·앱 확인으로 검증한다.

| 파일 | 확인하는 것 | 읽는 실제 데이터 |
|---|---|---|
| `src/ui/squirrel/motion-machine.test.ts`(얼굴·화면 연출 부분은 `motion-machine-faces.test.ts`로 나눔) | 6.4절 표의 모든 행: 시작 순서와 단계 시각, 동작 줄이기면 바로 `idle`, `working` -> `think`, 결과 -> 반응과 유지 시간, `answer`+`found`는 `cheer`+`smile`이고 `answer`+`notFound`·`aiFailed`는 반응 명령 없이 `think` -> `idle`(다른 `working`이 있으면 `think` 유지), 이미 처리한 id가 다시 와도 반응 없음, `settledIds`가 `rememberIds`개를 넘으면 가장 오래된 것부터 버림, 반응 뒤 남은 `working`이면 `think`, 더 작은 `sequence` 무시(같은 값은 받음), 숨김 중 결과는 반응 없음, 가장 최근 결과가 반응을 가짐(D15: 숨김 중 새 결과·반응 없는 새 결과가 앞선 반응을 끝냄), 진행 중·처리한 id의 반복 `working`은 활동만, `think`는 잠에 지지 않음, 무작위 연출은 `idle`에서만(입력창 열림·생각·잠·숨김이면 다시 예약, 동작 줄이기면 예약을 멈춤), 무작위 간격은 범위 전체에서 뽑음, 다음 얼굴은 앞 얼굴 끝 + 간격, `start` 전 입력, 연출 중 피드백이 같은 호출에서 실제 상태 명령을 돌려줌, 입력창 열림이 연출을 끊음, 10분 뒤 잠과 활동·피드백·입력창으로 깸, 얼굴: `idle` 4종·`think` 2종만 나오고 `nose_wiggle`·`smile`은 `think`에서 절대 안 나옴, 잠·연출·시작 중 얼굴 없음, 겹치기 방식이 설정과 같음, 허용되지 않는 얼굴은 상태 전환 때 `faceClear`, `presentation` 값(시작·중간·끝, 끊긴 뒤 돌아오기) | `bara.json`의 동작 길이, `SQUIRREL_MOTION` |
| `src/ui/squirrel/motion-validate.test.ts` | 설정의 모든 동작 이름이 실제 데이터에 있음, `startup`·`show` 단계 쌍이 허용 목록 안, 어두운 색 슬롯 없음, 이름 하나를 바꾼 설정 복사본은 `ANIMATION_MISSING`과 그 이름으로 실패, 허용 목록 밖 단계는 `TRANSITION_NOT_ALLOWED` | `bara.json`, `bara.atlas` |
| `src/ui/squirrel/camera.test.ts` | 순수 계산(띠·창 크기별 `s`와 범위, 받아들인 배치는 `contentBounds`를 모두 담고 띠가 너무 낮은 배치는 띠 0과 배치 A를 포함해 거부), 실제 데이터 포함 검사: 모든 몸통 동작과 설정한 시작·무작위 순서를 `Physics.update`·`Physics.pose`로 재생한 범위가 `contentBounds` 안, `tauri.conf.json`의 펫 창 크기와 띠 높이로 맞춘 카메라가 `contentBounds`를 모두 담고 `idle`의 가장 낮은 점이 띠 위에 있음, `presentCamera`가 `k=1, lift=0`에서 기준 카메라와 같고 `lift=1`에서 기준점을 시작 지점에 둠, 띠가 낮은 거부가 `CameraLayoutError`로 필요한 px와 띠 px를 담음. 띠 높이는 `style.css`의 `--pet-floor-inset`를 읽는다(한 번만 정의되고 px 값인지도 확인) | `bara.json`, `bara.atlas`, `src-tauri/tauri.conf.json`, (P2부터) `src/ui/style.css` |
| `src/ui/squirrel/squirrel-error-text.test.ts` | 모든 `SquirrelError` 코드(14개)에 문구가 있고 문구가 파일·동작 이름 같은 `detail`을 담음(`error-text.test.ts`와 같은 방식), 원인이 비어도 빈 괄호가 없음, `CAMERA_LAYOUT`은 실제 `fitCamera` 거부에서 출발해 두 높이를 담고 영어 문장이 없음, 명령 실패 문구가 원인과 "끝내지 못했어요"를 담음(그 말이 없는 원인으로 시험) | 코드 목록, `SQUIRREL_MOTION` |
| `src/ui/squirrel/pet-notice.test.ts` | 알림 줄 규칙: 명령 성공이 `command` 알림만 지움, 남는 알림이 덮였다 다시 보임, 새 지나가는 알림이 앞의 것을 대신함 | 실제 `messages.pet` 문구 |
| `src/ui/squirrel/squirrel-assets.test.ts` | `isPageInsteadOf`: HTML 응답이 HTML 아닌 파일 요청에 오면 "파일 없음", 파일 자신의 형식·형식 없음·HTML 파일 요청은 아님, Bun이 실제 `index.html`에 붙이는 형식도 "파일 없음" | 실제 `index.html` |
| `tests/ui-assets.test.ts` | `copyUiAssets`가 임시 폴더에 `bara.json`·`bara.atlas`와 아틀라스가 가리키는 모든 페이지 그림을 바이트 그대로 복사, Spine 라이선스 파일 복사, 복사 위치가 `asset-paths.ts`가 요청하는 경로와 같음 | 실제 그림 파일, `node_modules/@esotericsoftware/spine-webgl/LICENSE` |
| `src-tauri/src/native_host.rs` 테스트 모듈 | 계약의 `quickVisibilityEvent` 값 확인(P3), `answerOutcomes`가 비어 있지 않고 `is_answer_outcome`이 목록 값만 받음(P4) | `native-host.json` |
| `tests/service-assistant.test.ts`·`tests/service-ai.test.ts` (P4) | 검색 0건 -> `notFound`, AI 없이 찾음 -> `found`, AI 답변(인용 1개 이상) -> `found`, AI 실패 -> `aiFailed`. AI 답변은 인용이 1개 이상일 때만 존재하므로, 인용 0개 응답(`sourceIds: []`)은 `AI_RESPONSE`로 거부되어 `aiFailed`가 되고(`generated: false`, 찾은 기억 전부가 `sources`) 이것도 시험한다. 기존 실제 HTTP fixture 서버(`memoryFixture`)를 그대로 쓴다. `service-ai.test.ts`의 `searchOnlyAnswer` 비교(`toEqual`)에 `outcome`을 더한다 | 실제 HTTP fixture 서버 |
| `src/ui/feedback-model.test.ts` (P4) | `answerFeedback`이 `answerOutcome`을 서버 식별자가 다를 때(출처를 비울 때)도 그대로 실음 | 데이터 fixture |
| `src/ui/error-text.test.ts` (P4, `PROGRESS_STAGES` 대조와 같은 자리) | `ANSWER_OUTCOMES`와 `native-host.json`의 `contract.answerOutcomes`가 같음 | `native-host.json` |
| `src-tauri/src/feedback.rs` 테스트 모듈 (P4) | `answer`+세 값 각각 받음, `answer`에 값이 없으면 거부, `saved`·`working`·`error`에 값이 있으면 거부, 목록에 없는 글자 거부, 받은 값이 다시 직렬화될 때 그대로 남음 | JSON fixture |

기존 `tests/ui-entry.test.ts`는 진입 태그 치환만 보므로 그대로 통과해야 한다.

## 12. 검증 계획

`apps/pet`에서 실행한다.

1. `bun run typecheck`
2. `bun test src tests`
3. `bun run build:ui` 뒤 확인: `dist/assets/squirrel/bara.json|bara.atlas|bara.png`가 원본과 같은 해시, `dist/licenses/`에 Spine 라이선스, Spine 고유 문자열(`Region not found in atlas`, `Animation not found`, `PolygonBatch is already drawing`)이 Spine 조각에만 있고 `main.js`와 공유 조각에는 0건(압축이 클래스 이름을 바꿔 `SkeletonJson` 글자로는 확인할 수 없음, 3.5절), 네 창이 읽는 `main.js`+공유 조각이 구현 전 `main.js`(105,855바이트)보다 약 8% 많은 정도
4. 브라우저 미리보기: 작업 사본 밖 임시 스크립트로 `dist/`를 `127.0.0.1`에서 제공하고 `index.html?view=pet`을 연다. 보기 크기를 150x165로 맞춘다. 확인: 시작 연출(작게 위에서 -> 제자리 -> `cling` -> `land` -> `idle`), 숨쉬기, 얼굴 동작이 튀지 않음, 투명 배경에 테두리·검은 띠가 없음(특히 `eye_shadow_*` 곱하기 슬롯), DPR 1·1.5·2 선명도, 동작 줄이기 흉내(`prefers-reduced-motion`)에서 시작 연출 없음, `dist/assets/squirrel/bara.png` 이름을 잠시 바꿔 `ASSET_HTTP` 카드가 파일 이름과 404를 보임(없는 파일에 404를 돌려주는 미리보기·개발 서버 기준. 실제 앱은 `ASSET_MISSING`, 5번), 클릭으로 명령 실패 알림이 뜨고 카드와 함께 보여도 겹치지 않으며 카드 한가운데의 `elementFromPoint`가 펫 버튼, 콘솔 오류 없음. 상태 동작(`think`·`cheer`·`droop`·`sleep`·무작위 연출)은 브라우저에 피드백이 없으므로 5번에서 본다.
5. 실제 Tauri(`bun run dev`, 먼저 `bun run package:runtime`으로 개발용 실행 환경 준비): 클릭으로 입력창이 열리고 캐릭터는 평소 상태, 저장 -> `think` -> `cheer`+`smile`, 기억이 있는 질문 -> `think` -> `cheer`+`smile`, 기억이 하나도 없는 질문 -> `think` -> 반응 없이 `idle`, AI 서버를 끈 채 질문 -> 말풍선의 AI 실패 문구와 함께 반응 없이 `idle`, 트레이 "최근 답변"을 눌러도 다시 반응하지 않음, 서버를 끈 채 저장 -> `droop`+`side_eye`, 입력창 Esc·보낸 뒤·Alt+F4에서 펫 개발자 도구로 `pet-quick-visibility` 수신 확인, 끌기·오른쪽 클릭, Windows "애니메이션 효과" 끄기 후 재시작하면 시작 연출 없음, 10분 활동 없음 -> `sleep`, 마우스를 올리면 깸, 3~8분 안에 무작위 점프가 나오고 입력창이 열려 있으면 안 나옴, 트레이에서 숨기고 다시 보이기(숨은 동안 그리기가 멈추는지 개발자 도구 성능 기록으로 확인, O15), 다른 배율 모니터로 끌어 옮기기, 설치본에서 그림 파일 하나를 지웠을 때 `ASSET_MISSING` 카드
6. Rust: `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --tests -- -D warnings`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
7. 처리량 계산: 그리기 상한 30fps x 슬롯 63개, 물리 제약 38개는 20fps 단계라 프레임당 최대 1~2단계. 간격 자르기(0.1초)로 숨었다 돌아와도 한 프레임 물리 단계는 최대 2번이다. 실제 CPU·GPU 사용률은 5번에서 작업 관리자로 기록한다.

수행하지 않은 검증은 통과로 적지 않는다.

## 13. 결정 기록

| 번호 | 결정 | 이유 | 약점 | 가장 강한 다른 안 |
|---|---|---|---|---|
| D1 | 순수 상태 기계가 시간 흐름(단계 끝, 반응 유지, 예약)을 직접 관리하고 Spine에는 명령만 준다 | 사용자가 요청한 시험 방식(주입한 시계·난수, 명령 출력)과 맞고, 가짜 Spine 없이 모든 규칙을 시험할 수 있다 | Spine의 "앞 동작 끝나기 전에 섞기 시작" 같은 대기열 기능을 덜 쓴다. 단계가 바뀌는 순간이 최대 한 프레임 늦을 수 있다 | Spine `addAnimation` 대기열에 순서를 맡기고 `complete` 이벤트로 상태 기계에 알리기. 이음매는 더 정확하지만 진짜 상태가 Spine 안에 있어 시험에 실제 `AnimationState`가 필요하다 |
| D2 | 더하기 = `TrackEntry.additive = true` | 4.3.13 API에 `MixBlend`가 없음 | 4.2 자료와 이름이 달라 혼동할 수 있다 | 없음(API 사실) |
| D3 | `blink`는 덮어쓰기 | `idle`·`think`와 겹치는 키가 0개라 결과가 같고, 크기·그림 교체 키를 만든 그대로 쓴다 | 나중에 `idle`이 눈 뼈에 키를 잡으면 깜빡이는 동안 그 움직임이 멈춘다 | 더하기. 지금 데이터에서는 차이가 없다 |
| D4 | 고정 카메라 하나, 범위는 측정한 합친 범위 + 16단위 | 동작이 바뀌어도 크기·위치가 튀지 않음(요구) | 그림이 바뀌면 범위를 다시 재야 한다. 테스트가 실제 데이터로 넘침을 잡는다 | 제자리 동작만 담고 점프 때 창을 키우거나 옮기기. 창 이동은 U5·README 방침과 어긋난다 |
| D5 | 시작 연출 크기는 카메라로 처리 | 물리가 영향받지 않아 귀·비막이 크기 변화에 흔들리지 않는다 | 뼈대가 실제로 다가오는 것은 아니라 물리 반응이 없다 | `skeleton.scaleX/Y`·위치를 바꾸기. 물리가 움직임으로 받아들여 흔들린다 |
| D6 | `takeoff`·`touchdown` 이벤트는 연결하지 않는다 | 정해진 동작 중 이 이벤트로 바뀌는 것이 없다. 연결만 하면 쓰이지 않는 코드다 | 나중에 효과를 넣을 때 연결해야 한다 | 지금 연결해 상태 기계 입력으로 넘기기 |
| D7 | 창 150x165 유지, 캔버스가 창 전체, 바로가기 띠 겹침(배치 B). 사용자 확정(U10) | 지금 새 그림과 비슷한 크기, 네이티브·위치 저장 변경 없음 | 잠잘 때 꼬리 끝과 웅크린 발끝이 바로가기 뒤에 가려진다 | 창 150x200(C). 더 크게 보이지만 투명한 부분도 클릭을 받는 창이 커진다 |
| D8 | 그림은 빌드가 `dist/assets/squirrel/`로 복사하고 `fetch`로 읽는다. Spine 런타임은 동적 import로 분할 | 405KB JSON과 221KB 런타임을 다른 세 창이 읽지 않는다. 파일별 HTTP 상태로 원인을 보인다 | 실행 중 읽기 실패 경로가 생긴다(오류 카드로 보임). 빌드에 분할 설정이 추가된다 | JSON·아틀라스를 import로 번들에 넣기. 빌드 때 누락을 잡지만 모든 창이 큰 파일을 읽고 PNG 경로 처리가 까다롭다 |
| D9 | 입력창 열림·닫힘을 네이티브가 새 이벤트로 알린다 | 보임 변화는 Rust만 확실히 안다. JS 쪽 창 보임 조회는 변화 이벤트가 없어 주기 조회가 필요하다 | Alt+F4 경로에서 알림 실패는 보일 곳이 없다(영향은 장식 연출 정지뿐) | 펫이 `isVisible()`을 주기적으로 조회(`core:window:allow-is-visible` 권한 추가). 단순하지만 계속 깨어 조회한다 |
| D10 | 이전 후속 두 가지(펫 명령 실패 표시, 펫 CSS 토큰)를 이번에 함께 한다. 별도 커밋으로 나눈다 | 같은 펫 블록(`main.ts` 21~37행, CSS 421~473행)을 어차피 다시 쓰고, 오류 표시 자리도 이번에 만든다 | 기능 변경과 버그 수정이 한 묶음에 섞여 검토 범위가 넓어진다. 캐릭터를 되돌리면 수정도 함께 빠질 수 있다(커밋을 나눠 줄임) | 캐릭터만 바꾸고 후속은 다음 작업으로. 지금의 버려지는 실패가 그대로 남는다 |
| D11 | `error` 피드백은 종류와 상관없이 `droop`+`side_eye` | 말풍선이 "확인이 필요해요"로 보이는 것과 같은 사실만 따른다. 피드백에 "요청 실패"를 구분하는 필드가 없다 | 너무 긴 입력, 초안 보관 실패, 사용자가 누른 중단도 `droop`가 된다 | 계약에 실패 출처 필드 추가(Rust `deny_unknown_fields`라 Rust도 바뀜)(O5) |
| D12 | 숨은 창에서는 그리기와 움직임 시계를 멈춘다 | CPU 절약, 상태 기계와 Spine 시각 일치 | 잠드는 시간(U11의 10분)도 보이는 동안만 센다 | 벽시계로 잠 시간을 세기 |
| D13 | 답변 결과는 답변을 만드는 `assistant.ts`가 정한 계약 값 `answerOutcome`(`found`·`notFound`·`aiFailed`)으로 피드백에 싣는다. 값 목록은 `native-host.json` `contract.answerOutcomes` 한 곳, Rust는 `is_answer_outcome`으로 목록 밖 값과 잘못된 `kind`를 거부. 별도 묶음 P4(`sonnet`) | 펫이 받는 피드백에서 출처 수(`sources`)는 서버 식별자가 다르면 비워지고, "AI 없이 찾음"과 "AI 실패"는 문구 말고는 같다(3.6절). 값을 아는 곳에서 이름 붙인 값을 내보내면 문구가 바뀌어도 틀어지지 않는다 | 펫 표정 하나를 위해 서비스·화면·Rust 세 층의 계약이 바뀐다. "찾음"은 검색이 결과를 돌려줬다는 뜻일 뿐이라, 관련이 약한 기억만 찾았어도 `cheer`가 된다 | 계약은 그대로 두고 `quick.ts`가 서버 식별자 거르기 전의 원래 `Answer`에서 추측: 출처 0개 = 못 찾음. 하지만 "AI 실패"는 `generated: false`에 출처가 있어 "AI 없이 찾음"과 구분되지 않아 결국 `Answer`에 실패 표시 필드가 필요하고, `assistant.ts`의 반환 모양에 숨은 약속에 기대게 된다 |
| D14 | 같은 결과 피드백 id에는 한 번만 반응한다(최근 32개 id 기억) | 트레이 "최근 답변"이 저장된 피드백을 같은 id, 새 `sequence`로 다시 방송한다(3.6절). `sequence` 검사로는 막히지 않아 옛 답변을 열 때마다 다시 기뻐하게 된다 | 펫 창이 처음 보는 id의 재방송(예: 펫 창을 새로 불러온 직후)에는 반응할 수 있다. 앱 재시작 뒤에는 Rust에 저장된 답변도 없어 실제로는 생기기 어렵다 | Rust가 재방송임을 표시하는 필드를 피드백에 붙이기. 더 정확하지만 계약이 또 바뀐다 |
| D15 | 가장 최근 결과가 반응을 가진다(2026-10-04 메인 세션 결정, P1 QA). 더 새로운 결과 id가 오면 앞선 결과의 반응(`cheer`·`droop`)은 끝난다. 창이 보이고 새 결과가 반응할 결과면 그 반응으로 바뀐다. 반응 없는 결과(`notFound`·`aiFailed`)면 반응이 끝나고 우선순위대로 `think` 또는 `idle`이 된다. 창이 숨어 있으면 새 반응 없이 끝난다(늦은 반응 없음). 끝난 반응의 얼굴이 아직 돌면 `faceClear`로 함께 뺀다. 이미 처리한 id의 재방송과 진행 중 id의 반복 `working`은 지금처럼 활동으로만 친다 | 말풍선은 언제나 가장 최근 결과를 보여 준다. 캐릭터가 그보다 오래된 결과에 계속 반응하면 안 된다 | 앞선 결과의 반응이 짧게 끊길 수 있다(예: 저장 직후 기억이 없는 질문의 답이 오면 `cheer`가 바로 끝남). 숨긴 동안 온 결과 하나가 보이던 반응까지 지운다 | 반응을 끝까지 보여 주고 새 결과는 그 뒤에 반영하기. 연출은 온전하지만 말풍선과 캐릭터가 최대 6초 어긋난다 |

## 14. 열린 항목

| 번호 | 항목 | 추천 | 약점 | 가장 강한 다른 안 | 막는가 |
|---|---|---|---|---|---|
| O1 | 연결 실패가 이어지는 상태(U8) | 이번에는 표시하지 않음. 말풍선이 알린다 | 시작 때 연결 실패 뒤 캐릭터는 반응 한 번 뒤 평소 모습이다 | 연결 상태를 따로 받아 지속 표정을 두기(새 신호 필요) | 아니오 |
| O2 | "찾은 기억 없음" 동작 | 결정됨(U12): 반응 없이 `think` -> `idle`. 구분 신호는 D13 | - | - | 결정됨 |
| O3 | 잠들기·깨기 동작(U8) | 지금은 0.2초 섞기만 | `sleep`은 파츠를 통째로 바꿔서 섞기 시작 순간 그림이 확 바뀐다 | 잠들기·깨기 동작을 Spine에 추가 | 아니오 |
| O4 | 설정 창 머리글 그림이 여전히 새 | 다음 작업에서 날다람쥐 정지 그림(PNG 한 장)으로 교체 | 그때까지 두 캐릭터가 섞여 보인다 | 같은 Spine 캔버스를 머리글에도 쓰기(설정 창도 런타임을 읽게 됨) | 아니오 |
| O5 | `error` 전체를 `droop`로(D11) | 그대로 | 위 D11 약점 | 실패 출처 필드 추가 | 아니오 |
| O6 | 잠드는 기준·시간 | 결정됨(U11): 펫과의 상호작용(마우스 올림·누름, 피드백, 입력창 열림·닫힘) 10분 없음. 보이는 동안만 셈(D12) | 다른 프로그램으로 바쁘게 일해도 펫은 잔다 | - | 결정됨 |
| O7 | 반응 길이·얼굴 반복 | `cheer` 2회(2.67초), `droop` 3회(6.0초), `smile`·`side_eye`는 한 번 | `side_eye`(1초)는 `droop` 앞부분에만 보인다 | 반응 동안 얼굴도 반복 | 아니오 |
| O8 | 반응 중 무작위 얼굴 | 없음 | 6초 `droop` 동안 깜빡임이 없다 | `blink`만 허용 | 아니오 |
| O9 | 시작 연출 중 실제 피드백 | 즉시 끊고 0.2초 만에 제자리로 | 작은 크기에서 빠르게 커지는 모습이 보인다 | 착지까지 기다렸다 보이기(최대 약 4.6초 늦음) | 아니오 |
| O10 | 동작 줄이기 범위 | 시작 연출·무작위 연출만 끔 | 숨쉬기·얼굴 움직임은 남는다 | 몸통 상태만 바꾸고 숨쉬기·얼굴도 정지 | 아니오 |
| O11 | 화면 배치(D7) | 결정됨(U10): B, 창 150x165 유지 | 꼬리 끝 가림 | - | 결정됨 |
| O12 | 그리기 상한 | 30fps | 60Hz 화면에서 덜 부드럽다 | 60fps(그리기 비용 두 배) | 아니오 |
| O13 | 그 밖 기본값 | 5절 표의 설계자 기본값(섞기 0.2초, 얼굴 간격 2~6초·가중치, 무작위 연출 3~8분, 비행 1.6초·시작 크기 0.3) | 실제로 보며 조정이 필요할 수 있다 | 실제 앱에서 보며 정하기 | 아니오 |
| O14 | Spine 런타임과 펫의 AGPL-3.0-only 배포의 일관성 | Spine 쪽은 충족(U13): 사용자의 유료 Spine Editor 라이선스로 런타임 라이선스의 "Section 2에 따른 통합"이 되고, 재배포 때 라이선스·저작권 문구를 함께 넣어야 하는 조건은 빌드가 Spine `LICENSE`를 `dist/licenses/`에 복사해 맞춘다(P2, `tests/ui-assets.test.ts`가 확인). 남은 것은 펫을 AGPL로 받는 사람(다시 배포하는 사람 포함)에게 Spine 런타임이 섞인 결과가 AGPL 조건과 맞는지이며, 메인 세션이 사용자와 저작권자의 추가 허가 문구를 정한다 | 법률 판단은 이 설계가 할 수 없다. 추가 허가 문구 없이 배포하면 받는 사람이 AGPL만 보고 Spine 런타임까지 같은 조건으로 오해할 수 있다 | 배포 전 법률 확인 | 배포를 막음(구현은 아님) |
| O15 | 숨긴 창에서 WebView2가 `document.hidden`을 알려주는지 | 실제 앱에서 확인 | 알려주지 않으면 숨긴 펫도 계속 그린다 | 네이티브가 펫 창 보임을 이벤트로 알리기 | 아니오 |
| O16 | 기존 이벤트 이름 네 개를 계약 파일로 옮기기 | 별도 정리 작업 | 당분간 두 방식이 섞인다 | 이번에 함께 옮기기 | 아니오 |
| O17 | `glide` -> `cling` 전환 | U5(시작 순서)에 따라 허용 목록에 넣음 | U7 목록에는 없다 | U7만 따르면 시작 순서를 바꿔야 한다 | 아니오 |
| O18 | AI 답변이 실패한 질문(`aiFailed`) | 메인 세션 기본값: 반응 없이 `think` -> `idle`. 기억을 찾았으면 AI 유무와 상관없이 `cheer`+`smile` | 기억은 찾았는데도 기뻐하지 않는다 | `found`와 같이 `cheer`. 말풍선은 AI 실패를 알리는데 캐릭터는 기뻐해 신호가 엇갈린다 | 아니오(기본값으로 진행, 사용자 확인 대기) |

## 15. 구현 묶음과 순서

| 묶음 | 내용 | 파일 | 모델 | 완료 기준 |
|---|---|---|---|---|
| P1 움직임 규칙(순수 코드) | 설정, 타입, 예약 도우미, 상태 기계, 검증, 오류 코드, 카메라 계산, 테스트 도우미와 테스트 3개 | 4.1절 P1 행 | `opus` (규칙이 많고 우선순위·끊기 조합이 틀리기 쉬움) | `bun run typecheck`, `bun test src/ui/squirrel` 통과. 6.4절 모든 행에 테스트. P1 파일이 DOM·WebGL·Spine 실행 코드를 import하지 않음 |
| P3 네이티브·브리지 | 계약 필드, Rust 알림 함수와 호출 세 곳, 권한 설명, `bridge.ts` | 9절 표 | `sonnet` (범위가 분명함) | Rust 검사 3종, `bun run typecheck` 통과 |
| P4 답변 결과 계약 | `answerOutcome` 값 목록, `Answer.outcome`, `Feedback.answerOutcome`, `assistant.ts` 세 반환 지점, `answerFeedback`, `quick.ts` 호출, Rust 받기·검사, 테스트 5곳 | 9.1절 표 | `sonnet` (모양과 값의 뜻이 이 문서에 정해져 있음) | `bun run typecheck`, `bun test src tests`, Rust 검사 3종 통과. 11절 P4 행 |
| P2 렌더러·화면·빌드 | 파일 읽기, 렌더러, 루프, 런타임, 오류 문구, 펫 화면, `main.ts`, `messages.ts`, CSS, 빌드 복사·분할·라이선스, 테스트 2개, `art/squirrel/README.md`·`docs/status.md` 갱신. D10의 두 후속은 별도 커밋 | 4.1절 P2 행 | `opus` (PMA·DPR·문맥 잃음·숨김 처리) | 12절 1~5 |

순서:

1. P3(진행 중)와, "`classificationFailureReason` 수정 커밋 -> P4 -> P1" 흐름을 함께 진행한다. P4는 그 수정과 같은 `feedback.rs`·`feedback-model.ts`·테스트를 고치므로 수정이 커밋된 뒤 시작하고, P3와 겹치는 `native-host.json`·`native_host.rs`는 먼저 끝난 쪽 위에 더한다. P1은 `AnswerOutcome` 타입을 쓰므로 P4 뒤에 시작한다.
2. P2는 P1의 `MotionMachine`·설정·카메라, P3의 `onQuickVisibility`, P4의 `Feedback.answerOutcome`을 모두 쓰므로 셋이 끝난 뒤 진행한다. 각 묶음 뒤 qa(`opus`)가 이 문서와 대조하고, PASS 뒤 다음으로 넘어간다. 실제 앱 확인(12절 5번)은 사용자 화면에서 한다.

## 16. 범위 밖에서 발견한 결함

- 저장은 됐지만 AI 분류가 실패한 경우, `src/ui/feedback-model.ts`의 `savedFeedback`이 `classificationFailureReason` 필드를 붙이는데 Rust `feedback.rs`의 `Feedback`(`#[serde(deny_unknown_fields)]`)에 이 필드가 없어 `publish_feedback`이 `HOST_INVALID_REQUEST`로 거부했다(코드 읽기로 확인). 그러면 `quick.ts`의 `catch`가 성공한 저장을 오류 말풍선으로 바꿔 보이고, 이 설계에서는 캐릭터가 `droop`가 된다. 이 결함은 지금 같은 브랜치(`feat/pet-squirrel`)에서 별도 커밋으로 고치는 중이다: Rust `Feedback`에 `classification_failure_reason` 필드를 더하고, TS 쪽 요약을 `shortSummary`로 줄여 호스트의 240바이트 제한을 넘지 않게 한다. 이 설계의 작업 묶음에는 들어가지 않으며, P4는 그 커밋 뒤에 시작한다(15절).
- 버려진 오목 작업 사본의 `bird.ts`는 그림을 읽지 못하면 `null`로 넘기고 "unavailable" 표시만 하는 조용한 대체 방식이었다. 이번 설계는 같은 방식을 쓰지 않는다(8절).
