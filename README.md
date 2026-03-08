# Notepad

웹 브라우저로 접속하면 누구나 동시에 편집할 수 있는 실시간 공유 메모장입니다.
저장 버튼 없이 다른 사람의 변경 사항이 즉시 화면에 반영되며, 서비스를 재시작해도 내용이 유지됩니다.

---

## 기능

- 실시간 동시 편집 (WebSocket / Socket.IO)
- 자동 저장 (파일 기반, DB 불필요)
- 접속자 수 실시간 표시
- 연결 상태 / 저장 상태 인디케이터
- 글자 수 · 줄 수 카운터

---

## 기술 스택

| 구분 | 기술 |
|---|---|
| 런타임 | Node.js 20 |
| 언어 | TypeScript 5 |
| HTTP 서버 | Express 4 |
| 실시간 통신 | Socket.IO 4 (WebSocket) |
| 영속성 | 로컬 파일 (`data/notepad.txt`) |
| 컨테이너 | Docker + Docker Compose |

---

## 서비스 구성 및 기술적 고려사항

### 1. 실시간 동기화 — Socket.IO

WebSocket(Socket.IO)을 사용해 저장 버튼 없이 편집 내용이 모든 접속자에게 즉시 전파됩니다.

```
클라이언트 A 입력
  └─▶ 서버 (update 이벤트 수신)
        ├─▶ 클라이언트 B (update 이벤트 브로드캐스트)
        └─▶ 클라이언트 C (update 이벤트 브로드캐스트)
```

서버는 변경을 보낸 클라이언트를 제외한 나머지(`socket.broadcast`)에게만 전송해 **에코 루프**를 방지합니다.

### 2. 버전 번호로 충돌 방지

모든 `update` 이벤트에는 단조 증가하는 `version` 번호가 포함됩니다.

- 서버는 클라이언트가 보낸 버전이 현재보다 **낮으면** 해당 업데이트를 거부하고 최신 상태를 `init` 이벤트로 돌려보냅니다.
- 클라이언트도 수신한 버전이 현재보다 낮은 이벤트는 무시합니다.

이 방식으로 네트워크 지연·순서 역전으로 인한 **오래된 내용 덮어쓰기**를 방지합니다.

### 3. 디바운싱 — 두 겹의 지연 처리

| 위치 | 지연 | 목적 |
|---|---|---|
| 클라이언트 | 80 ms | 타이핑 중 소켓 메시지 폭주 억제 |
| 서버 | 500 ms | 디스크 I/O 폭주 억제 |

클라이언트는 80 ms 동안 입력이 없으면 서버에 전송하고, 서버는 마지막 변경으로부터 500 ms 후에 파일에 씁니다.
결과적으로 빠르게 타이핑하는 동안 디스크 쓰기는 초당 최대 2회 수준으로 제한됩니다.

### 4. 파일 기반 영속성 — DB 없이 재시작 후 복원

데이터베이스 대신 `data/notepad.txt` 파일에 내용을 저장합니다.

- 서버 시작 시 파일을 읽어 메모리에 올립니다.
- 변경이 있을 때마다 디바운싱 후 파일에 씁니다.
- `SIGINT` / `SIGTERM` 수신 시 디바운스 타이머를 무시하고 **즉시 동기 쓰기** 후 종료합니다 (`flushSync`).

도커 볼륨(`notepad-data`)에 마운트하면 컨테이너 교체·재시작과 무관하게 데이터가 유지됩니다.

### 5. 커서 위치 보존

원격 변경을 수신했을 때 `textarea.value`를 단순 대입하면 커서가 맨 끝으로 이동합니다.
클라이언트는 업데이트 전 커서 위치를 저장하고, 내용 길이 변화량(`delta`)을 반영해 커서를 복원합니다.

### 6. 멀티 스테이지 Docker 빌드

```
builder 스테이지   node:20-alpine  →  tsc 컴파일
runner 스테이지    node:20-alpine  →  prod 의존성 + dist/ + public/ 만 포함
```

빌드 도구(ts-node, typescript 등)를 최종 이미지에서 제외해 **이미지 크기**를 최소화합니다.

---

## 로컬 실행 방법

### 사전 준비

- Node.js 20 이상

### 개발 모드 (ts-node)

```bash
# 의존성 설치
npm install

# 개발 서버 시작
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
# 빌드
docker build -t notepad .

# 실행
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
│   └── server.ts          # Express + Socket.IO 서버
├── public/
│   ├── index.html         # UI
│   ├── style.css          # 스타일
│   └── client.js          # 클라이언트 Socket.IO 로직
├── data/                  # 런타임 생성 — notepad.txt 저장 위치
├── dist/                  # tsc 빌드 결과물 (gitignore)
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```
