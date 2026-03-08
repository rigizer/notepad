# Notepad

웹 브라우저로 접속하면 누구나 동시에 편집할 수 있는 실시간 공유 메모장입니다.
10개의 독립 채널을 제공하며, 채널별로 제목과 내용을 실시간으로 함께 편집할 수 있습니다.
저장 버튼 없이 변경 사항이 즉시 반영되고, 서비스를 재시작해도 내용이 유지됩니다.

---

## 기능

- **10개 채널** — 채널별 독립 제목 + 내용
- **실시간 동시 편집** — WebSocket(Socket.IO)으로 즉시 전파
- **실시간 제목 편집** — 채널 내부에서 제목을 입력하면 목록에도 실시간 반영
- **접속자 수** — 전체 + 채널별 동시 접속자 수 실시간 표시
- **자동 저장** — 파일 기반, DB 불필요, 재시작 후 복원
- **Tab 들여쓰기** — Tab 키로 공백 4칸 삽입
- **연결 상태 / 저장 상태 인디케이터**
- **글자 수 · 줄 수 카운터**

---

## 기술 스택

| 구분 | 기술 |
|---|---|
| 런타임 | Node.js 20 |
| 언어 | TypeScript 5 |
| HTTP 서버 | Express 4 |
| 실시간 통신 | Socket.IO 4 (WebSocket) |
| 영속성 | 로컬 파일 (`data/channels.json`) |
| 컨테이너 | Docker + Docker Compose |

---

## 서비스 구성 및 기술적 고려사항

### 1. 10채널 구조 — Socket.IO 룸 기반 격리

각 채널은 독립된 `{ title, content, version }` 상태를 가지며, Socket.IO **룸(room)** 으로 격리됩니다.

```
클라이언트 A (채널 3 입장)   →  socket.join("channel-3")
클라이언트 A 입력             →  서버가 "channel-3" 룸에만 브로드캐스트
클라이언트 B (채널 5 입장)   →  "channel-3" 이벤트를 받지 않음
```

- `joinChannel` / `leaveChannel` 이벤트로 룸 입퇴장을 명시적으로 관리합니다.
- 제목 변경(`updateTitle`)만 **전체 클라이언트**에게 브로드캐스트합니다 — 목록 화면에서 실시간으로 제목이 갱신되어야 하기 때문입니다.

### 2. 실시간 동기화 — 에코 루프 방지

```
클라이언트 A 입력
  └─▶ 서버 (updateContent 수신)
        ├─▶ ack         → 클라이언트 A (버전 갱신용)
        └─▶ contentUpdate → 채널 룸의 다른 클라이언트 (B, C …)
```

`socket.broadcast.to(room).emit()` 으로 발신자를 제외한 나머지에게만 전송해 에코 루프를 방지합니다.

### 3. 버전 번호로 충돌 방지

모든 `updateContent` 이벤트에는 단조 증가하는 `version` 번호가 포함됩니다.

- 서버는 수신된 버전이 현재보다 **낮으면** 거부하고 `channelInit`(최신 상태)을 발신자에게 반송합니다.
- 이 방식으로 네트워크 지연·순서 역전으로 인한 **오래된 내용 덮어쓰기**를 방지합니다.

### 4. Ack 이벤트로 글자 씹힘 방지

서버가 업데이트를 수락해도 발신자에게 알리지 않으면, 클라이언트의 `localVersion`이 갱신되지 않아 연속 전송 시 버전 충돌이 반복됩니다.

**문제 시나리오:**
```
클라이언트 전송  →  { content: "ab", version: 0 }
서버 수락        →  내부 version = 1, 브로드캐스트
클라이언트 전송  →  { content: "abc", version: 0 }  ← version이 0 그대로!
서버 판단        →  0 < 1 이므로 거부 → "c" 씹힘
```

**해결책: `contentAck` 이벤트**
```
서버 수락  →  contentAck { version: 1 } 발신자에게 반환
클라이언트 →  localVersion = 1 갱신 → 이후 전송은 version: 1 사용
```

추가로, `ack` 대기 중 들어온 원격 업데이트는 `pendingRemote`에 보관했다가 `ack` 후에 적용합니다. 타이핑 도중 다른 사람의 변경이 내 텍스트를 덮어쓰지 못하게 합니다.

### 5. IME 조합 중 전송 차단 (한국어 · 중국어 · 일본어)

IME는 여러 키입력을 하나의 문자로 조합하는 동안 `compositionstart` ~ `compositionend` 이벤트를 발생시킵니다.
조합 도중 소켓 전송이 일어나면 미완성 글자가 전달되어 서버 응답이 돌아올 때 조합 중인 글자가 깨집니다.

클라이언트는 `isComposing` 플래그로 이 구간을 추적하고, `compositionend` 이후에만 전송합니다.

```javascript
editor.addEventListener('compositionstart', () => { isComposing = true; });
editor.addEventListener('compositionend',   () => {
  isComposing = false;
  clearTimeout(sendTimer);
  sendTimer = setTimeout(doSendContent, SEND_DEBOUNCE_MS);
});
```

### 6. Tab 키 — 4칸 공백 들여쓰기

브라우저 기본 동작(포커스 이동)을 막고 커서 위치에 공백 4개를 삽입합니다.
선택 영역이 있으면 선택 범위를 공백으로 치환합니다.

```javascript
editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const start = editor.selectionStart;
  editor.value = editor.value.substring(0, start) + '    '
               + editor.value.substring(editor.selectionEnd);
  editor.selectionStart = editor.selectionEnd = start + 4;
  editor.dispatchEvent(new Event('input')); // 동기화 흐름 유지
});
```

### 7. 디바운싱 — 두 겹의 지연 처리

| 위치 | 대상 | 지연 | 목적 |
|---|---|---|---|
| 클라이언트 | 내용 전송 | 80 ms | 타이핑 중 소켓 메시지 폭주 억제 |
| 클라이언트 | 제목 전송 | 300 ms | 제목 입력 중 소켓 메시지 억제 |
| 서버 | 디스크 쓰기 | 500 ms | 디스크 I/O 폭주 억제 |

### 8. 파일 기반 영속성 — DB 없이 재시작 후 복원

데이터베이스 대신 `data/channels.json` 파일에 10개 채널의 제목·내용·버전을 저장합니다.

- 서버 시작 시 파일을 읽어 메모리에 올립니다.
- 변경이 있을 때마다 디바운싱(500 ms) 후 파일에 씁니다.
- `SIGINT` / `SIGTERM` 수신 시 디바운스 타이머를 무시하고 **즉시 동기 쓰기** 후 종료합니다 (`flushSync`).

도커 볼륨(`notepad-data`)에 마운트하면 컨테이너 교체·재시작과 무관하게 데이터가 유지됩니다.

### 9. 실시간 접속자 수 — 전체 + 채널별

`users` 이벤트는 전체 접속자 수와 채널별 접속자 수를 함께 전달합니다.

```typescript
{ total: number, channels: number[] }  // channels[i] = i번 채널의 현재 인원
```

채널 입장(`joinChannel`)·퇴장(`leaveChannel`)·연결·해제 시마다 전체 클라이언트에 브로드캐스트되어 목록 화면의 카드와 채널 화면의 배지가 실시간으로 갱신됩니다.

### 10. 커서 위치 보존

원격 변경을 수신했을 때 `textarea.value`를 단순 대입하면 커서가 맨 끝으로 이동합니다.
클라이언트는 커서 앞 텍스트 prefix를 비교해 동일하면 커서를 그대로 유지하고, 달라졌으면 길이 변화량(`delta`)으로 보정합니다.

### 11. 멀티 스테이지 Docker 빌드

```
builder 스테이지   node:20-alpine  →  tsc 컴파일
runner 스테이지    node:20-alpine  →  prod 의존성 + dist/ + public/ 만 포함
```

빌드 도구(ts-node, typescript 등)를 최종 이미지에서 제외해 이미지 크기를 최소화합니다.

---

## 로컬 실행 방법

### 사전 준비

- Node.js 20 이상

### 개발 모드 (ts-node)

```bash
npm install
npm run dev
```

### 프로덕션 빌드 후 실행

```bash
npm install
npm run build
npm start
```

브라우저에서 [http://localhost:5050](http://localhost:5050) 접속

---

## Docker 실행 방법

### 1. appleboy 네트워크 생성 (최초 1회)

```bash
docker network create appleboy
```

### 2. 빌드 및 실행

```bash
docker compose up -d --build
```

### 3. 중지

```bash
docker compose down
```

> 데이터는 `notepad-data` 볼륨에 보존됩니다.
> `docker compose down -v` 를 실행하면 볼륨도 함께 삭제됩니다.

### 개별 Docker 명령으로 실행하는 경우

```bash
docker build -t notepad .

docker run -d \
  --name notepad \
  --network appleboy \
  -p 5050:5050 \
  -v notepad-data:/app/data \
  --restart unless-stopped \
  notepad
```

브라우저에서 [http://localhost:5050](http://localhost:5050) 접속

---

## 프로젝트 구조

```
notepad/
├── src/
│   └── server.ts          # Express + Socket.IO 서버 (10채널 관리)
├── public/
│   ├── index.html         # 목록 뷰 + 채널 뷰 (SPA)
│   ├── style.css          # 다크 테마 스타일
│   └── client.js          # 클라이언트 Socket.IO 로직
├── data/                  # 런타임 생성 — channels.json 저장 위치
├── dist/                  # tsc 빌드 결과물 (gitignore)
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```
