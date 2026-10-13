# 날다람쥐 펫 Spine 원본

오목눈이 그림을 대신할 날다람쥐 캐릭터의 Spine 원본과 내보낸 파일이다. 펫 창은 이 내보낸 파일을 Spine 런타임 4.3.13(`@esotericsoftware/spine-webgl`)으로 그린다(2026-10-04 연결). 설계와 재생 규칙의 근거는 `../../docs/decisions/2026-10-04-squirrel-spine-design.md`, 그리는 코드와 움직임 규칙은 `../../src/ui/squirrel/`에 있다.

- UI 빌드(`bun run build:ui`)가 `bara.json`·`bara.atlas`와 아틀라스가 가리키는 그림 파일을 `dist/assets/squirrel/`에 바이트 그대로 복사하고, 펫 창이 실행 중에 그 파일을 읽는다. Spine 런타임 라이선스 문서는 `dist/licenses/`에 복사된다.
- 내보낸 파일 이름을 바꾸면 `../../src/ui/squirrel/asset-paths.ts`의 상수 한 곳만 고친다. 그림 파일 이름은 아틀라스가 정하므로 따로 적지 않는다.
- 동작 이름을 바꾸거나 지우면 `../../src/ui/squirrel/motion-config.ts`의 설정과 맞지 않게 되고, 펫 창은 빠진 동작 이름을 적은 오류 카드를 보인다(`bun test src/ui/squirrel`도 실패한다).

## 수정 후 다시 내보내기

실행하는 **같은 작업 사본**의 `apps/pet/src/ui/assets/squirrel/`에 `bara.json`·`bara.atlas`와 아틀라스가 가리키는 PNG를 함께 내보낸다. 원본 저장소와 `.worktrees/` 안 작업 사본은 서로 다른 폴더이므로 한쪽에 내보내도 다른 쪽에는 자동 반영되지 않는다. 편집한 `bara.spine`도 같은 작업 사본의 `apps/pet/art/squirrel/`에 보관한다.

내보낸 뒤 그 작업 사본의 `apps/pet`에서 `bun run dev`를 다시 실행하면 UI 자산을 복사하고 앱을 실행한다. 설치용 실행 파일은 다시 빌드해야 한다. 캐릭터 로더는 확장자가 낯선 `.atlas`를 Tauri가 `text/html`로 표시하더라도 실제 atlas 내용이면 그대로 읽으며, 실제 HTML 대체 응답만 파일 없음으로 판단한다.

## 파일

| 위치 | 내용 |
|---|---|
| `bara.spine` | Spine 원본 프로젝트. 편집기 4.3.26 |
| `images/` | 파츠 원본 PNG 65개 |
| `../../src/ui/assets/squirrel/bara.json` | 내보낸 뼈대와 애니메이션(JSON, nonessential data 끔) |
| `../../src/ui/assets/squirrel/bara.atlas`, `bara.png` | 파츠를 모은 그림 한 장(2048x512), `pma:true`, filter `MipMapLinearNearest,Linear` |

앱의 Spine 런타임은 편집기와 같은 4.3 계열이어야 한다. 4.3 JSON은 제약을 `constraints` 하나로 묶어 적기 때문에 4.2 이하 런타임은 이 파일을 읽지 못한다.

## 뼈대

- 뼈 130개, 슬롯 63개, 스킨 `default` 하나. 어떤 애니메이션도 루트 뼈(`root`)에 키를 잡지 않는다. 창은 움직이지 않는다. 펫 창은 모든 몸통 동작을 담는 고정 카메라로 그리고, 시작 연출의 "멀리서 날아와 커짐"도 카메라의 위치와 배율만 바꿔 보인다(설계 7.3절, 결정 D5).
- `head2`·`head3`은 볼 뼈다. 얼굴·귀 메시는 머리·볼·귀 뼈에 가중치로 붙어 있어서, 메시 모양을 바꾸는 키도 이 뼈들의 이동·회전 키로 저장된다.
- physics 제약: 귀, 수염, 팔, 비막, 머리. ik 2개, transform 2개(팔과 접힌 비막 연결).
- 기본 자세의 범위는 가로 약 428, 세로 약 490 단위다. 펼친 비막·점프 같은 동작은 이 범위를 넘는다.

## 애니메이션

몸통 동작은 한 번에 하나, 얼굴 동작은 몸통 위에 겹쳐 재생하는 것으로 만들었다. 앱 상태와의 연결은 아래 "정해진 재생 규칙"에 적은 것만 정했다.

| 이름 | 층 | 길이(초) | 동작 |
|---|---|---|---|
| `idle` | 몸통 | 2.00 | 숨쉬기 |
| `think` | 몸통 | 6.27 | 갸웃 |
| `sleep` | 몸통 | 4.00 | 웅크려 잠자기. 전용 파츠(`sleep_*`)로 바꾸고 평소 파츠를 숨긴다 |
| `cling` | 몸통 | 2.00 | 화면 유리에 정면으로 철퍼덕 붙어 5프레임 멈췄다가 60프레임까지 천천히 미끄러져 내려온다(30fps) |
| `jump` | 몸통 | 1.00 | 점프. 0.73초에 이벤트 `takeoff`(발이 떨어지는 순간) |
| `glide` | 몸통 | 0.67 | 비막을 펴고 활공(반복) |
| `land` | 몸통 | 1.00 | 착지. 0.20초에 이벤트 `touchdown`(발이 닿는 순간) |
| `cheer` | 몸통 | 1.33 | 팔 펼쳐들기 |
| `droop` | 몸통 | 2.00 | 팔이 축 늘어진 기운 빠진 자세 |
| `blink` | 얼굴 | 1.40 | 눈 깜빡임 세 번(`head` 슬롯 그림을 `head_02`로 바꿨다 되돌림) |
| `ear_flap` | 얼굴 | 1.53 | 귀 파닥 |
| `nose_wiggle` | 얼굴 | 2.00 | 코 씰룩 |
| `smile` | 얼굴 | 2.40 | 웃기 |
| `side_eye` | 얼굴 | 1.00 | 흰자가 보이게 눈치 보기 |

전환: `jump` 다음은 `glide` 또는 `cling`, 그 다음은 `land`. `jump` 뒤에 바로 `land`를 이으면 제자리 점프가 된다.

## 정해진 재생 규칙 (2026-10-04)

- 잠자는 동안에는 얼굴 동작을 재생하지 않는다. 특히 `blink`는 `head` 슬롯 그림을 바꾸므로 `sleep` 중에 재생하면 자는 몸 위에 깨어 있는 머리가 나타난다.
- 갸웃(`think`) 중에는 `nose_wiggle`을 재생하지 않는다.
- 앱 시작: `glide` -> `cling` -> `land` -> `idle`.
- 클릭은 입력창을 여는 입구라 클릭 반응 동작은 두지 않는다. `jump` -> `cling` -> `land` -> `idle` 흐름은 평소 상태에서 무작위로 재생한다.

## 겹쳐 재생할 때 알려진 점

- `ear_flap`·`nose_wiggle`·`smile`·`side_eye`는 몸통 동작도 키를 잡는 귀 회전과 `head`·`head2`·`head3` 이동에 키가 있다(의도한 것). 기본 방식(덮어쓰기)으로 겹치면 얼굴 동작이 도는 동안 숨쉬기의 볼·귀 움직임이 멈춘다. 눈·코 쪽 뼈는 `jump`·`land`·`cling`하고만 겹친다.
- 앱 방침(2026-10-04 사용자 결정 U4로 확정): `ear_flap`·`nose_wiggle`·`smile`은 더하기(additive, Spine 4.3의 `TrackEntry.additive`)로 겹쳐 숨쉬기를 살리고, `side_eye`는 만든 표정 그대로 보이도록 덮어쓰기로 겹친다(더하면 귀 회전 -71도가 몸통 값에 더해진다).
