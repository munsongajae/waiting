# 그리운보리밥 웨이팅

입구 태블릿으로 손님이 접수하고, 카운터 태블릿에서 직원이 호출·입장을 처리하는 웨이팅 시스템입니다.
데이터는 Supabase(서울 리전)에 저장되고 문자는 솔라피로 보냅니다.

```
web/        태블릿·휴대폰에서 여는 화면 (이 폴더를 배포)
  index.html    입구 태블릿 — 손님 접수
  admin.html    관리자 — 카운터 태블릿(직원), 사장님 휴대폰/PC
  s.html        손님 휴대폰 — 문자 링크로 여는 '내 순서 확인'
  config.js     Supabase 연결 정보 (설치할 때 채움)
supabase/
  setup.sql     데이터베이스·권한·문자 발송 설정 (SQL Editor에서 실행)
server.js     PC에서 미리 보기용 로컬 서버 (node server.js)
```

## 누가 무엇을 할 수 있나

| 기기 | 계정 역할 | 할 수 있는 것 |
| --- | --- | --- |
| 입구 태블릿 | 입구 태블릿 (kiosk) | 웨이팅 접수만 |
| 카운터 태블릿 | 카운터 (staff) | 호출, 입장, 취소·노쇼, 직접 등록, 접수 중지 |
| 사장님 휴대폰/PC | 사장님 (owner) | 위 전부 + 통계, 설정, 문자 키, 기기 관리 |
| 손님 휴대폰 | 로그인 없음 | 문자 링크로 내 순서 보기, 순서 미루기(2번까지), 취소 |

- 로그인하지 않았거나 역할이 없는 계정은 아무것도 조회하거나 바꿀 수 없습니다. 이 제한은 화면이 아니라 데이터베이스에서 막습니다.
- 태블릿을 잃어버리면 사장님 화면 → 설정 → 기기 관리에서 그 계정의 **사용**을 끄면 바로 막힙니다.

## 개인정보

- 전화번호와 순서 확인 링크는 **다음 날 0시 5분에 자동 삭제**됩니다.
- 인원, 접수·호출·입장 시각, 결과(입장/취소/노쇼)는 전화번호 없이 남아 통계에 쓰입니다.

---

## 설치 (처음 한 번)

### 1. Supabase 프로젝트 만들기

1. https://supabase.com/dashboard 에서 조직(Organization) → **New project**
2. 이름: `gbb-waiting` 등 / Database Password: 직접 정해서 따로 보관 / **Region: Northeast Asia (Seoul)**
3. 만들어질 때까지 1~2분 기다리기

### 2. 데이터베이스 설정

1. 왼쪽 메뉴 **SQL Editor** → New query
2. `supabase/setup.sql` 내용을 전부 붙여 넣고 **Run**
3. 앱을 업데이트할 때도 같은 방법으로 다시 실행하면 됩니다. 여러 번 실행해도 기존 데이터는 그대로입니다.

### 3. 로그인 설정과 계정 만들기

1. **Authentication → Sign In / Providers** → *Allow new users to sign up* 를 **끄기**
   (모르는 사람이 계정을 만들지 못하게. 만들어도 권한이 없어 아무것도 못 하지만 꺼 두는 게 깔끔합니다)
2. **Authentication → Users → Add user → Create new user** 로 계정 3개를 만듭니다. *Auto Confirm User* 를 체크하세요.

   | 용도 | 이메일 예시 |
   | --- | --- |
   | 사장님 | 사장님 실제 이메일 |
   | 카운터 태블릿 | `counter@boribap.kr` (실제로 없는 주소여도 됨) |
   | 입구 태블릿 | `kiosk@boribap.kr` |

3. SQL Editor에서 사장님 계정에 권한을 줍니다 (이메일만 바꿔서 실행).

   ```sql
   select private.assign_role('사장님이메일@example.com', 'owner');
   select private.assign_role('counter@boribap.kr', 'staff');
   select private.assign_role('kiosk@boribap.kr', 'kiosk');
   ```

   사장님 권한만 SQL로 주고, 나머지는 나중에 사장님 화면 → 설정 → 기기 관리에서 정해도 됩니다.

### 4. 화면에 Supabase 연결

**Project Settings → API** (또는 상단 **Connect**) 에서 두 값을 복사해 `web/config.js` 에 넣습니다.

- Project URL → `supabaseUrl`
- `anon` 또는 `publishable` 키 → `supabaseKey`

> `service_role` / `secret` 키는 절대 넣지 마세요. 공개용 키만 넣습니다.

### 5. 인터넷에 올리기 (Netlify + GitHub)

1. https://app.netlify.com → **Add new project → Import an existing project → GitHub** → 이 저장소 선택
2. 빌드 설정은 `netlify.toml` 에 들어 있으므로 그대로 **Deploy** (배포 폴더: `web`, 빌드 명령 없음)
3. 생성된 주소(`https://이름.netlify.app`)를 확인합니다. Site configuration → Change site name 에서 `boribap-wait` 처럼 짧게 바꾸면 문자 속 링크가 짧아집니다.

이후에는 GitHub에 올릴 때마다 자동으로 다시 배포됩니다.

`web/_redirects` 덕분에 `주소/admin` 은 관리자 화면, `주소/s/…` 는 손님 확인 화면으로 열립니다.

### 6. 기기 준비

| 기기 | 여는 주소 | 로그인 계정 |
| --- | --- | --- |
| 입구 태블릿 | `https://이름.netlify.app` | 입구 태블릿 계정 |
| 카운터 태블릿 | `https://이름.netlify.app/admin` | 카운터 계정 |
| 사장님 휴대폰 | `https://이름.netlify.app/admin` | 사장님 계정 |

- 크롬 메뉴(⋮) → **홈 화면에 추가** 하면 앱처럼 전체화면으로 실행됩니다. 로그인은 한 번만 하면 유지됩니다.
- 입구 태블릿: 삼성 **설정 → 보안 → 앱 고정**을 켜 두면 손님이 다른 앱으로 나가지 못합니다.
- 입구 태블릿의 숨은 메뉴(새로고침·전체화면·로그아웃): **매장 이름을 3초 길게 누르기**
- 카운터 태블릿은 새 손님이 접수되면 "띵동" 소리가 납니다. 켠 뒤 화면을 한 번 눌러야 소리가 활성화됩니다.

### 7. 문자(솔라피) 켜기

1. https://solapi.com 가입 → 매장 번호를 **발신번호로 등록** → 잔액 충전 → **API Key 만들기**
2. 사장님 계정으로 관리자 화면 → **설정**
   - 솔라피 API 키: API Key, API Secret 입력 → 키 저장
   - 문자 알림: **문자 보내기** 체크, 발신번호 입력, 사이트 주소 확인 → 설정 저장
   - 내 번호로 **테스트 문자** 보내서 확인

문자 문구는 설정에서 바꿀 수 있습니다. 90바이트(한글 약 45자)를 넘으면 장문 요금이 붙으니 옆에 표시되는 바이트 수를 확인하세요.
기본 문구는 링크를 포함해 90바이트 안에 들어가도록 맞춰 두었습니다.

---

## 운영 중 자주 쓰는 기능

- **접수 중지**: 재료 소진, 마감 직전. 카운터 화면 상단 `접수 중` 버튼
- **자동 마감**: 설정의 *최대 대기 팀*, *접수 마감 시각*
- **직접 등록**: 전화 문의 손님, 번호를 원하지 않는 손님 (번호 없이 등록 가능)
- **노쇼**: 호출 후 설정한 시간(기본 5분)이 지나면 줄이 빨갛게 바뀌고 `노쇼` 버튼이 나타납니다
- **되돌리기**: 입장·취소·노쇼 처리 후 5초 동안 화면 아래 `되돌리기`, 그 뒤에는 `완료` 탭에서
- **통계**: 요일·시간대별 대기시간, 날짜별 팀 수, 인원수별 대기, 엑셀(CSV) 내려받기
- **예상 대기시간**: 최근 90분 동안 4팀 이상 입장하면 실제 입장 속도로 자동 계산

## PC에서 미리 보기

```bash
node server.js
```

http://localhost:8080 (입구), http://localhost:8080/admin (관리자). `web/config.js` 에 Supabase 정보가 있어야 동작합니다.
