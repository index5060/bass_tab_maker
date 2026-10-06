# 로컬 사이드카 — 분리 + AI 채보

브라우저 분리는 **고정된 양자화 모델 하나**만 돌립니다. 모델을 고를 수도, shifts나 overlap을
건드릴 수도, GPU를 쓸 수도 없습니다. 그런데 베이스 스템이 깨끗하게 나오느냐 뚝뚝 끊기느냐를
가르는 게 정확히 그 설정들입니다.

사이드카는 웹앱을 그대로 둔 채, 무거운 작업만 옆에서 도는 작은 로컬 프로세스에 맡깁니다.
페이지가 localhost로 호출하고, 안 떠 있으면 앱은 조용히 브라우저 분리로 돌아갑니다.

**전부 이 컴퓨터 안에서 끝납니다.** 서버는 `127.0.0.1`에만 바인딩하고 외부에서는 닿지 않습니다.

---

## 두 가지 일을 합니다

| | 하는 일 | 필요한 패키지 |
|---|---|---|
| **분리** | 원본에서 베이스 스템을 뽑음 | `demucs` |
| **AI 채보** | 그 스템에서 음표를 뽑음 | `basic-pitch` |

둘은 독립입니다. 하나만 깔아도 그 기능만 켜지고, 없는 쪽은 앱이 조용히 브라우저
경로(브라우저 분리 / YIN 채보)로 돌아갑니다.

---

## 설치

Python 3.9 이상. 서버 자체는 표준 라이브러리만 씁니다.

**Windows:**

```
py -m pip install demucs basic-pitch
```

**macOS / Linux:**

```
python3 -m pip install demucs basic-pitch
```

Python을 여러 개 깔아두셨다면 **사이드카가 실제로 고른 그 인터프리터**에 깔아야 합니다.
`npm run sidecar`가 첫 줄에 어느 걸 골랐는지 찍어주니 그대로 쓰세요:

```
py -3.12 -m pip install basic-pitch
```

> Windows에는 `python3` 명령이 없습니다. Microsoft Store 스텁만 있어서
> `WindowsApps\python3.exe을(를) 찾을 수 없습니다`라는 엉뚱한 에러가 납니다.
> Windows는 `py` 런처를 쓰세요.

GPU가 있으면 CUDA용 PyTorch를 먼저 깔아두세요. CPU 대비 10배 이상 빠릅니다.

## 실행

프로젝트 폴더에서:

```
npm run sidecar
```

`sidecar/run.mjs`가 설치된 Python을 전부 훑어서 **능력으로** 고릅니다:

```
Python 확인 중…
  py -3.12   Python 3.12.10 · demucs 있음 · CUDA (NVIDIA GeForce RTX 4070)
  py -3.14   Python 3.14.0  · demucs 없음 · torch 없음

선택: py -3.12 (Python 3.12.10)
  GPU 사용: NVIDIA GeForce RTX 4070
```

버전 번호로 고르면 안 되기 때문입니다. 3.9는 최신 torch에 너무 낮고, **3.14는 너무 높아서
CUDA wheel이 아직 없습니다** — 설치하면 조용히 CPU 빌드가 깔립니다. 그런데 `py -3`은
가장 최신을 집어주죠. GPU를 못 쓰는 바로 그 버전을요.

특정 인터프리터를 강제하려면:

```
set BASS_SIDECAR_PYTHON=C:\Python312\python.exe
npm run sidecar
```

직접 띄우고 싶으면:

```
py sidecar\server.py          REM Windows
python3 sidecar/server.py     # macOS / Linux
```

이렇게 뜨면 정상입니다:

```
Bass Practice 사이드카  http://127.0.0.1:8765
  demucs 4.0.1 · basic-pitch 0.4.0 · 장치 cuda (NVIDIA GeForce RTX 4070)
  종료하려면 Ctrl+C
```

`basic-pitch 없음`이라고 나오면 채보는 브라우저 내장 YIN으로 돌아갑니다. 서버는 정상입니다.

**dev 서버와 별도 터미널에서 띄우세요.** 둘 다 떠 있어야 합니다.

브라우저를 새로고침하면 스템 분리 패널에 "로컬 사이드카 사용" 상자가 나타나고, 버튼이
"사이드카로 분리하기"로 바뀝니다.

## 설정

| 설정 | 뜻 | 대가 |
|---|---|---|
| **모델** | `htdemucs_ft`가 가장 깨끗합니다 | 기본 모델보다 약 4배 느림 |
| **shifts** | 신호를 조금씩 밀어 여러 번 돌린 뒤 평균. 이음매 아티팩트가 줄어듭니다 | 값만큼 시간이 곱해짐 |
| **overlap** | 처리 구간을 얼마나 겹칠지. 경계가 부드러워집니다 | 0.5면 0.25의 약 1.5배 |

끊김이 거슬리면 **`htdemucs_ft` + shifts 2 + overlap 0.5**부터 시도해보세요. 4분 곡이
GPU에서 몇 분, CPU에서는 훨씬 오래 걸립니다.

## 왜 CORS 헤더가 있나

앱 페이지는 일부러 cross-origin isolated 상태입니다(COOP/COEP). 브라우저 분리가
SharedArrayBuffer를 쓰려면 그래야 하거든요. 그 결과 다른 오리진인 사이드카의 응답은
CORS뿐 아니라 **CORP까지** 요구받습니다. 둘 중 하나만 빠져도 fetch가 아무것도 설명하지
않는 네트워크 에러로 실패합니다. `_cors()`에 둘 다 들어있는 이유입니다.

## 엔드포인트

| | |
|---|---|
| `GET /health` | demucs / basic-pitch 버전, 장치, 사용 가능한 모델 |
| `POST /separate?model=&shifts=&overlap=&ext=` | 본문에 오디오 바이트. 작업 id 반환 |
| `POST /transcribe?ext=` | 본문에 **베이스 스템** 바이트. 작업 id 반환 |
| `GET /jobs/{id}` | 상태와 진행률 |
| `GET /jobs/{id}/bass` · `/no_bass` | 결과 WAV |
| `GET /jobs/{id}/notes` | 채보 결과 JSON (`midi`, `startMs`, `endMs`, `confidence`) |
| `DELETE /jobs/{id}` | 임시 파일 정리 |

작업은 한 시간 뒤 자동으로 정리되고, 앱은 결과를 받는 즉시 삭제를 호출합니다.

## AI 채보에 대해

`/transcribe`는 [basic-pitch](https://github.com/spotify/basic-pitch)(Spotify, Apache-2.0)를
돌립니다. 자기상관 방식과 달리 **온셋과 피치를 함께 학습한 신경망**이라, 다시 친 음과 이어진
음을 구분합니다.

주파수 창을 **30–500Hz로 고정**해서 보냅니다. 베이스 스템에 남은 심벌 잔향이나 하모닉스가
엉뚱한 고음 음표로 잡히는 걸 입구에서 막습니다.

돌려주는 건 음표 이벤트뿐입니다. 그리드 피팅·양자화·지판 배치·alphaTex 작성은 전부
브라우저에서 (`notesToAutoTab()`) 합니다. 내장 YIN 경로와 **같은 코드**를 지나기 때문에,
필기 쪽 버그를 고치면 두 엔진이 같이 좋아집니다.

## 테스트

진짜 demucs나 basic-pitch 없이 프로토콜만 검증할 수 있습니다. `_stubdemucs/`에 둘 다
스텁이 있습니다 — demucs 스텁은 같은 명령줄을 받아 같은 모양의 진행률을 뱉고 실제 위치에
파일을 쓰고, basic-pitch 스텁은 A1 4분음표 4개를 냅니다.

```
npm run test:sidecar
```

확인하는 것:

- isolated 페이지에서 실제로 교차 출처 호출이 되는가 (curl로는 증명 불가)
- 분리가 끝까지 돌고 스템에 출처가 기록되는가
- 채보가 basic-pitch 경로로 갔다고 표시되는가
- **스텁의 같은 음 4개가 4개로 남는가** — 한때 하나로 뭉쳤던 회귀를 막습니다
