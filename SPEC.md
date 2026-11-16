# quick-llm-memory

## Software Requirements Specification & Technical Design Document

- 프로젝트명: quick-llm-memory
- 약칭: QLM
- 문서 버전: 1.0.0
- 문서 유형: 최종 제품 설계 명세서
- 작성 기준일: 2026-11-16
- 대상 플랫폼: Windows 10/11, macOS, Linux
- 주요 언어: TypeScript
- 런타임: Node.js
- 인터페이스: TUI (Terminal User Interface) / CLI
- 데이터 저장: Markdown, JSON, YAML, SQLite
- 외부 연동: Model Context Protocol (MCP)
- 개발 형태: Local-first Open Source Application

---

# 1. 프로젝트 개요

## 1.1. 프로젝트 정의

quick-llm-memory는 대규모 설계 명세서, 프로젝트 문서 및 기술 자료를 AI가 분석하여 계층적인 Markdown 지식 저장소로 자동 변환하고, LLM이 필요한 정보만 선택적으로 탐색할 수 있도록 지원하는 로컬 지식 관리 시스템이다.

기존의 단일 Markdown 문서 또는 대형 프로젝트 문서를 LLM에 제공하는 방식은 프로젝트 규모가 커질수록 다음 문제를 발생시킨다.

1. 불필요한 정보로 인한 토큰 소비 증가
2. LLM의 컨텍스트 윈도우 낭비
3. 문서 규모에 따른 검색 효율 저하
4. 필요한 정보의 위치 파악 어려움
5. 중복되거나 상충하는 문서 증가
6. 변경된 내용의 추적 및 갱신 어려움
7. 여러 AI 개발 도구 사이의 지식 재사용 어려움

quick-llm-memory는 이러한 문제를 해결하기 위해 지식을 작은 단위로 분리하고, 상위 문서에는 하위 문서에 대한 설명과 탐색 경로만 제공하는 계층형 구조를 채택한다.

또한 MCP 서버를 제공하여 외부 AI 개발 도구가 필요한 문서만 요청할 수 있도록 한다.

## 1.2. 핵심 목표

### G-001. 자동 지식 구조 생성

사용자가 입력한 설계 명세서를 AI가 분석하여 카테고리, 하위 카테고리 및 문서 구조를 자동 생성한다.

### G-002. 계층적 정보 접근

프로젝트 전체 내용을 한 번에 읽지 않고 단계적으로 필요한 정보를 탐색한다.

### G-003. 토큰 소비 최적화

질문 및 작업과 직접 관련된 문서만 반환하여 컨텍스트 사용량을 줄인다.

### G-004. 로컬 우선 설계

지식 저장소 및 검색 인덱스는 사용자의 로컬 파일 시스템에 저장한다.

### G-005. 외부 AI 도구 연결

MCP 프로토콜을 통해 다양한 AI 개발 도구에서 동일한 지식 저장소를 사용할 수 있도록 한다.

### G-006. 터미널 기반 관리

GUI 없이 TUI 및 CLI만으로 프로젝트 생성, 문서 관리, 검색, 서버 관리 및 설정 변경이 가능해야 한다.

### G-007. 점진적 지식 갱신

원본 문서가 수정되었을 경우 변경된 부분과 영향을 받는 문서만 갱신한다.

### G-008. 확장 가능한 구조

AI Provider, 검색 엔진, 저장소 및 MCP 전송 방식 등을 교체하거나 확장할 수 있는 모듈형 구조를 제공한다.

---

# 2. 제품 범위

## 2.1. 최종 지원 기능

| 구분 | 기능 | 최종 제품 |
|---|---|---|
| 프로젝트 | 프로젝트 생성 및 삭제 | 지원 |
| 프로젝트 | 다중 프로젝트 관리 | 지원 |
| 프로젝트 | 기존 프로젝트 불러오기 | 지원 |
| 프로젝트 | 프로젝트 내보내기 | 지원 |
| 입력 | Markdown 문서 | 지원 |
| 입력 | 일반 텍스트 | 지원 |
| 입력 | PDF 문서 | 지원 |
| 입력 | Git 저장소 | 지원 |
| 입력 | 로컬 디렉터리 | 지원 |
| 입력 | DOCX 문서 | 지원 |
| 입력 | URL 문서 | 지원 |
| AI | 자동 카테고리 설계 | 지원 |
| AI | 자동 Markdown 분할 | 지원 |
| AI | 문서 요약 | 지원 |
| AI | 문서 간 관계 분석 | 지원 |
| AI | 중복 내용 탐지 | 지원 |
| AI | 상충 정보 탐지 | 지원 |
| AI | 증분 업데이트 | 지원 |
| 검색 | 파일 경로 검색 | 지원 |
| 검색 | 키워드 검색 | 지원 |
| 검색 | 의미 기반 검색 | 지원 |
| 검색 | 계층형 탐색 | 지원 |
| 검색 | 하이브리드 검색 | 지원 |
| 검색 | 토큰 예산 제한 | 지원 |
| MCP | stdio 서버 | 지원 |
| MCP | Streamable HTTP 서버 | 지원 |
| MCP | Tools | 지원 |
| MCP | Resources | 지원 |
| MCP | Prompts | 지원 |
| MCP | 읽기 전용 모드 | 기본값 |
| MCP | 승인 기반 쓰기 | 선택 지원 |
| UI | TUI Dashboard | 지원 |
| UI | 트리 탐색기 | 지원 |
| UI | 문서 뷰어 | 지원 |
| UI | 설정 화면 | 지원 |
| UI | MCP 관리 | 지원 |
| CLI | 전체 핵심 기능 | 지원 |
| 운영 | 로그 관리 | 지원 |
| 운영 | 백업 및 복원 | 지원 |
| 운영 | 무결성 검사 | 지원 |

## 2.2. 기본 설계 원칙

1. Markdown 파일을 지식의 원본으로 사용한다.
2. SQLite는 검색 및 메타데이터 인덱스로 사용한다.
3. SQLite가 손상되더라도 Markdown만으로 재구축할 수 있어야 한다.
4. AI의 생성 결과는 반드시 검증한다.
5. 원본 문서는 기본적으로 수정하지 않는다.
6. 사용자가 직접 수정한 내용은 AI 재생성 과정에서 보호한다.
7. MCP 서버는 기본적으로 읽기 전용으로 제공한다.
8. 프로젝트별 데이터와 설정을 격리한다.
9. 검색 결과에는 가능한 한 원본 출처를 표시한다.
10. 검색 과정에서 전체 프로젝트 문서를 불필요하게 로딩하지 않는다.

---

# 3. 기술 스택

## 3.1. 핵심 기술

| 영역 | 기술 | 목적 |
|---|---|---|
| 언어 | TypeScript | 전체 애플리케이션 |
| 런타임 | Node.js LTS | 실행 환경 |
| TUI | Ink + React | 터미널 인터페이스 |
| CLI | Commander | 명령어 파싱 |
| 스키마 | Zod | 입력 및 데이터 검증 |
| 데이터베이스 | SQLite | 메타데이터 관리 |
| DB 드라이버 | better-sqlite3 | SQLite 접근 |
| 전문 검색 | SQLite FTS5 | 키워드 검색 |
| 벡터 검색 | SQLite 벡터 확장 또는 별도 인덱스 | 의미 검색 |
| Markdown | unified + remark | Markdown 파싱 |
| YAML | yaml | Frontmatter 처리 |
| MCP | 공식 MCP TypeScript SDK | MCP 서버 |
| AI | Provider Adapter | LLM API 추상화 |
| 로깅 | pino | 구조화 로그 |
| 테스트 | Vitest | 단위 및 통합 테스트 |
| 빌드 | tsup | JavaScript 번들링 |
| 품질 검사 | ESLint + TypeScript | 정적 검사 |

라이브러리는 구현 시점에 호환 가능한 버전 조합을 검증하여 고정한다.

## 3.2. 지원 AI Provider

최종 제품은 다음 Provider Adapter를 제공한다.

- OpenAI
- Anthropic
- Google Gemini
- Ollama
- OpenAI-compatible API
- Custom HTTP Provider

각 Provider는 동일한 인터페이스를 구현한다.

```typescript
interface AIProvider {
  id: string;

  listModels(): Promise<ModelInfo[]>;

  generate(
    request: GenerateRequest
  ): Promise<GenerateResponse>;

  generateStructured<T>(
    request: StructuredRequest<T>
  ): Promise<T>;

  countTokens(
    text: string,
    model: string
  ): Promise<number>;
}
```

`countTokens`는 정확한 토크나이저가 없는 Provider의 경우 추정값을 반환할 수 있다.

이때 정확한 측정값과 추정값을 구분해야 한다.

Embedding은 별도 인터페이스를 제공한다.

```typescript
interface EmbeddingProvider {
  id: string;

  embed(
    texts: string[],
    model: string
  ): Promise<number[][]>;
}
```

LLM과 Embedding 모델은 독립적으로 선택할 수 있어야 한다.

---

# 4. 전체 시스템 아키텍처

## 4.1. 구성 요소

```text
+----------------------------------------------------+
|                 quick-llm-memory                   |
+----------------------------------------------------+
|                                                    |
|                  Interface Layer                   |
|                                                    |
|         +-------------+  +-------------+           |
|         |     TUI     |  |     CLI     |           |
|         +------+------+  +------+------+           |
|                |                |                  |
|                +--------+-------+                  |
|                         |                          |
|                         v                          |
|                Application Core                    |
|                         |                          |
|         +---------------+---------------+          |
|         |               |               |          |
|         v               v               v          |
|  Knowledge Builder  Retrieval Engine  MCP Manager  |
|         |               |               |          |
|         v               v               v          |
|  AI Provider Layer  Search Index     MCP Server    |
|         |               |               |          |
|         +---------------+---------------+          |
|                         |                          |
|                         v                          |
|                 Storage Layer                      |
|                         |                          |
|          +--------------+--------------+           |
|          |              |              |           |
|          v              v              v           |
|       Markdown        SQLite        Snapshots       |
|                                                    |
+----------------------------------------------------+
```

## 4.2. 모듈 책임

### Interface Layer

- 사용자 입력 처리
- 프로젝트 선택
- 작업 실행
- 진행률 표시
- 오류 표시
- 설정 변경

### Application Core

- 서비스 간 작업 조정
- 프로젝트 생명주기 관리
- 작업 큐 관리
- 설정 로딩
- 오류 처리
- 권한 검증

### Knowledge Builder

- 문서 분석
- 지식 구조 설계
- 문서 생성
- 문서 분할
- 문서 관계 연결
- 구조 검증

### Retrieval Engine

- 계층 탐색
- 검색 후보 추출
- 검색 결과 순위 결정
- 토큰 예산 적용
- 컨텍스트 구성

### MCP Manager

- MCP 실행 설정
- 클라이언트 설정 생성
- 연결 상태 확인
- 서버 실행 및 종료
- MCP 도구 관리

### Storage Layer

- Markdown 저장
- SQLite 인덱스
- 메타데이터
- 스냅샷
- 로그 및 작업 기록

---

# 5. 파일 시스템 설계

## 5.1. 기본 데이터 경로

운영체제별 기본 저장 경로는 다음과 같다.

Windows:

```text
%LOCALAPPDATA%\quick-llm-memory\
```

macOS:

```text
~/Library/Application Support/quick-llm-memory/
```

Linux:

```text
${XDG_DATA_HOME:-~/.local/share}/quick-llm-memory/
```

설정 파일은 운영체제별 사용자 설정 디렉터리에 저장한다.

사용자는 `QLM_HOME` 환경변수로 데이터 저장 경로를 변경할 수 있다.

## 5.2. 전역 저장 구조

```text
quick-llm-memory/
├── config/
│   ├── config.yaml
│   ├── providers.yaml
│   └── mcp-clients.json
│
├── projects/
│   ├── gsm-sv/
│   ├── moil-backend/
│   └── serox/
│
├── cache/
│   ├── ai/
│   ├── parsing/
│   └── embeddings/
│
├── logs/
│   ├── application.log
│   ├── builder.log
│   └── mcp.log
│
├── runtime/
│   ├── jobs/
│   └── servers/
│
└── backups/
```

API 키는 가능한 경우 운영체제의 보안 저장소에 저장한다.

보안 저장소를 사용할 수 없는 환경에서는 환경변수 사용을 권장한다.

평문 설정 파일에 API 키를 저장하는 기능은 기본적으로 제공하지 않는다.

## 5.3. 프로젝트 저장 구조

```text
projects/
└── gsm-sv/
    ├── project.yaml
    │
    ├── knowledge/
    │   ├── index.md
    │   │
    │   ├── security/
    │   │   ├── index.md
    │   │   ├── authentication.md
    │   │   ├── authorization.md
    │   │   │
    │   │   └── vm/
    │   │       ├── index.md
    │   │       ├── create.md
    │   │       ├── delete.md
    │   │       └── access.md
    │   │
    │   ├── api/
    │   │   ├── index.md
    │   │   ├── team/
    │   │   └── instance/
    │   │
    │   ├── infrastructure/
    │   │   ├── index.md
    │   │   └── proxmox/
    │   │
    │   └── database/
    │       └── index.md
    │
    ├── sources/
    │   ├── manifest.json
    │   └── originals/
    │
    ├── metadata/
    │   ├── manifest.json
    │   └── relationships.json
    │
    ├── index/
    │   └── knowledge.db
    │
    ├── snapshots/
    │
    └── state/
        └── jobs.json
```

`knowledge/` 디렉터리는 생성된 Markdown 지식의 실제 저장 위치다.

나머지 디렉터리는 시스템 관리 목적으로 사용한다.

---

# 6. Knowledge Hierarchy 설계

## 6.1. 계층 구조

지식은 다음 계층으로 구성한다.

```text
Project
  └── Domain
       └── Category
            └── Subcategory
                 └── Document
                      └── Section
```

단, 고정된 Depth를 강제하지 않는다.

프로젝트 구조에 따라 깊이는 달라질 수 있다.

## 6.2. Depth

Depth는 프로젝트 루트를 0으로 하는 상대적인 깊이다.

```text
Depth 0: /
Depth 1: /security/
Depth 2: /security/vm/
Depth 3: /security/vm/create.md
```

기본 최대 Depth는 5로 설정한다.

사용자가 변경할 수 있도록 한다.

```yaml
knowledge:
  hierarchy:
    min_depth: 1
    max_depth: 5
    auto_depth: true
```

`auto_depth`가 활성화되면 AI가 문서 복잡도에 따라 적절한 깊이를 제안한다.

단, 사용자가 지정한 최대 Depth를 초과할 수 없다.

## 6.3. 계층 분할 기준

다음 조건을 고려한다.

1. 주제의 독립성
2. 문서의 길이
3. 다른 문서와의 의존성
4. 검색 시 함께 필요한 정보
5. 용어 및 개념의 응집도
6. API 또는 기능 단위의 경계
7. 사용자 설정
8. 토큰 예산

서로 다른 주제는 가능한 한 별도 문서로 분리한다.

반대로 항상 함께 읽어야 하는 매우 짧은 내용은 하나의 문서에 유지할 수 있다.

## 6.4. 문서 분할 정책

기본 정책:

```yaml
document:
  target_tokens: 1000
  max_tokens: 2000
  min_tokens: 150

  preserve_code_blocks: true
  preserve_tables: true
  preserve_headings: true

  split_strategy: semantic
```

토큰 제한은 절대적인 분할 기준이 아니다.

코드 블록, 표, 설명의 의미를 훼손하는 분할은 금지한다.

하나의 독립적인 콘텐츠 단위가 제한보다 길 경우 예외를 허용하고 경고를 기록한다.

## 6.5. index.md 규칙

모든 카테고리 디렉터리는 `index.md`를 포함한다.

`index.md`에는 다음 정보를 포함한다.

- 카테고리명
- 카테고리 목적
- 포함된 하위 카테고리
- 포함된 문서
- 각 항목에 대한 짧은 설명
- 상위 카테고리 경로
- 관련 카테고리
- 주요 검색 키워드

예시:

```markdown
---
id: security
title: Security
type: category-index
depth: 1
---

# Security

프로젝트의 인증, 인가 및 보안 정책을 관리한다.

## Categories

| Path | Description |
|---|---|
| vm/ | 가상머신 관련 보안 정책 |

## Documents

| Path | Description |
|---|---|
| authentication.md | 인증 정책 |
| authorization.md | 권한 검증 정책 |

## Related

- ../api/index.md
- ../infrastructure/index.md
```

상위 `index.md`에는 하위 문서의 전체 본문을 복사하지 않는다.

## 6.6. 문서 Frontmatter

모든 일반 문서는 다음 메타데이터를 사용한다.

```yaml
---
schema_version: 1
id: security.vm.create
title: VM Creation Security
type: document

category: security
depth: 3

tags:
  - security
  - vm
  - creation

status: verified

source_ids:
  - source-001

source_sections:
  - source-001:section-12

related:
  - security.authorization
  - api.instance.create

created_at: 2026-11-16T00:00:00Z
updated_at: 2026-11-16T00:00:00Z

generation:
  provider: openai
  model: configured-model
  revision: 1
---
```

필수 필드:

- schema_version
- id
- title
- type
- depth
- status

나머지 필드는 문서 성격에 따라 선택적으로 사용할 수 있다.

문서 ID는 경로와 분리된 논리적 식별자로 관리한다.

파일을 이동해도 가능한 한 동일 ID를 유지한다.

---

# 7. Knowledge Builder

## 7.1. 역할

Knowledge Builder는 입력 자료를 분석하고 Markdown 지식 저장소로 변환한다.

## 7.2. 입력 형식

지원 입력:

- Markdown
- TXT
- PDF
- DOCX
- 로컬 디렉터리
- Git Repository
- URL
- HTML 문서

Git Repository 입력 시 다음 항목을 분석할 수 있다.

- README
- 문서 디렉터리
- 설정 파일
- 소스 코드 구조
- API 정의 파일
- 주요 모듈 및 의존성

대규모 저장소는 모든 파일을 AI에 전달하지 않는다.

우선 파일 목록과 구조를 분석한 후 필요한 파일만 선택한다.

바이너리, 빌드 결과물, 의존성 디렉터리 등은 기본적으로 제외한다.

## 7.3. 생성 파이프라인

```text
INPUT
  |
  v
Source Loader
  |
  v
Document Parser
  |
  v
Section Extractor
  |
  v
Source Normalizer
  |
  v
Structure Analyzer
  |
  v
AI Hierarchy Planner
  |
  v
Hierarchy Validator
  |
  v
User Preview
  |
  v
Document Generator
  |
  v
Content Validator
  |
  v
Atomic Commit
  |
  v
Index Builder
  |
  v
COMPLETE
```

## 7.4. Source Loader

입력 파일을 읽어 내부 Source 객체로 변환한다.

```typescript
interface SourceDocument {
  id: string;
  path: string;
  format: string;

  content: string;
  hash: string;

  size: number;
  modifiedAt: string;

  metadata: Record<string, unknown>;
}
```

파일 해시는 SHA-256을 사용한다.

## 7.5. Document Parser

각 형식에 맞는 Parser Adapter를 사용한다.

```typescript
interface DocumentParser {
  supports(format: string): boolean;

  parse(
    source: SourceDocument
  ): Promise<ParsedDocument>;
}
```

Parser는 문서를 제목, 본문, 코드 블록, 표 등의 구조적 단위로 분리한다.

PDF에서는 페이지 번호와 추출 위치를 보존한다.

DOCX에서는 제목 스타일과 표 구조를 최대한 유지한다.

## 7.6. Section Extractor

파싱한 문서를 의미 있는 Section으로 분리한다.

```typescript
interface SourceSection {
  id: string;
  sourceId: string;

  title: string;
  content: string;

  headingPath: string[];

  startOffset: number;
  endOffset: number;

  tokenCount: number;
  hash: string;
}
```

원본 위치 정보는 생성된 문서의 출처를 추적하기 위해 사용한다.

## 7.7. AI Hierarchy Planner

AI는 전체 자료를 분석하여 계층 구조를 설계한다.

결과는 자유 형식 Markdown이 아니라 JSON Schema로 제한한다.

```typescript
interface HierarchyNode {
  id: string;
  name: string;

  type: "category" | "document";

  path: string;
  description: string;

  sourceSectionIds: string[];

  children?: HierarchyNode[];
}
```

Planner가 수행하는 작업:

1. 주요 도메인 추출
2. 기능 및 주제 분류
3. 상위 카테고리 결정
4. 하위 카테고리 생성
5. 문서별 책임 정의
6. 원본 Section과 대상 문서 매핑
7. 관련 문서 관계 추론
8. 최종 계층 트리 생성

## 7.8. Hierarchy Validator

AI가 반환한 구조를 검증한다.

검증 항목:

- JSON Schema 적합성
- 최대 Depth 준수
- 중복 경로
- 경로 형식
- 순환 계층
- 누락된 원본 Section
- 하나의 문서에 과도하게 집중된 내용
- 비정상적으로 작은 문서
- 불필요한 카테고리
- 파일 시스템 예약 이름

Windows와 호환되지 않는 파일명은 생성하지 않는다.

모든 경로는 상대 경로로 정규화한다.

`..`을 통한 상위 디렉터리 접근은 금지한다.

## 7.9. Document Generator

검증된 계층 구조를 기준으로 각 문서를 생성한다.

생성 입력:

- 대상 문서의 목적
- 연결된 원본 Section
- 상위 카테고리 설명
- 관련 문서 목록
- 작성 규칙
- 토큰 제한

생성 결과:

- Frontmatter
- 제목
- 본문
- 출처
- 관련 문서

생성 과정에서 원본 자료에 존재하지 않는 사실을 확정적으로 추가해서는 안 된다.

AI가 추론한 내용은 별도로 구분해야 한다.

## 7.10. 생성 상태

```text
QUEUED
  |
  v
PARSING
  |
  v
PLANNING
  |
  v
VALIDATING
  |
  v
AWAITING_APPROVAL
  |
  v
GENERATING
  |
  v
VERIFYING
  |
  v
COMMITTING
  |
  v
INDEXING
  |
  v
COMPLETED
```

각 실행 상태에서 오류가 발생하면 FAILED 상태로 전환한다.

사용자 취소 시 CANCELLED 상태로 전환한다.

장시간 작업은 체크포인트를 저장하여 중단된 단계부터 재개할 수 있도록 한다.

---

# 8. AI 생성 비용 및 안정성

## 8.1. 작업 단위

전체 생성 작업을 작은 Job으로 분리한다.

```typescript
interface BuildJob {
  id: string;
  projectId: string;

  status: JobStatus;

  completedSteps: string[];
  pendingSteps: string[];

  estimatedTokens: number;
  consumedTokens: number;

  estimatedCost?: number;
  actualCost?: number;
}
```

## 8.2. 동시 실행 제한

AI API 요청은 설정된 동시 실행 개수를 초과하지 않는다.

```yaml
ai:
  concurrency: 3
  max_retries: 3
  timeout_seconds: 120
```

Rate Limit 응답이 발생하면 지수 백오프를 적용한다.

## 8.3. 비용 제한

사용자는 작업당 비용 상한을 설정할 수 있다.

```yaml
ai:
  budget:
    enabled: true
    max_cost_usd: 2.0
```

예상 비용이 상한을 초과하면 TUI에 경고한다.

실제 API 사용량과 공급자별 과금 기준을 기록한다.

정확한 가격 정보를 얻을 수 없으면 추정 비용으로 표시한다.

## 8.4. 캐싱

동일한 입력과 동일한 설정으로 수행한 AI 요청은 결과를 재사용할 수 있다.

캐시 키에는 다음 값을 포함한다.

- 원본 내용 해시
- Provider
- Model
- Prompt Version
- 생성 옵션
- Schema Version

민감한 문서에 대한 AI 응답 캐싱은 설정으로 비활성화할 수 있다.

---

# 9. Retrieval Engine

## 9.1. 목적

질문에 필요한 문서만 탐색하고 반환한다.

전체 문서를 무조건 로딩하지 않는다.

## 9.2. 검색 방식

다음 검색 방식을 지원한다.

1. Path Search
2. Hierarchical Search
3. Full-text Search
4. Semantic Search
5. Hybrid Search

## 9.3. Path Search

사용자가 정확한 문서 경로를 알고 있을 때 사용한다.

예시:

```bash
qlm read security/vm/create.md
```

## 9.4. Hierarchical Search

루트에서 시작하여 카테고리를 단계적으로 탐색한다.

예시:

```text
Question:
VM 생성 권한은 어떻게 검증하는가?

/
 |
 v
security/
 |
 v
vm/
 |
 v
create.md
```

## 9.5. Full-text Search

SQLite FTS5를 사용한다.

검색 대상:

- 제목
- 경로
- 본문
- 태그
- 설명

한글 검색 품질을 위해 토큰화 전략을 별도로 설계한다.

기본 FTS5 토크나이저만으로 충분하지 않을 경우 애플리케이션 단에서 한글 검색용 토큰을 생성한다.

## 9.6. Semantic Search

Embedding을 이용하여 의미적으로 유사한 문서를 검색한다.

각 문서 또는 Section의 벡터를 저장한다.

Embedding 모델과 벡터 차원은 인덱스 메타데이터에 기록한다.

Embedding 모델이 변경되면 관련 벡터 인덱스를 재구축한다.

## 9.7. Hybrid Search

계층 탐색, 키워드 검색, 의미 검색 결과를 결합한다.

기본 결합 방식은 Reciprocal Rank Fusion(RRF)으로 한다.

각 검색기의 순위를 결합하여 최종 후보 순위를 생성한다.

향후 별도 Reranker를 추가할 수 있도록 인터페이스를 분리한다.

## 9.8. 검색 인터페이스

```typescript
interface SearchRequest {
  projectId: string;
  query: string;

  mode:
    | "path"
    | "hierarchical"
    | "fulltext"
    | "semantic"
    | "hybrid";

  maxResults: number;
  maxTokens: number;

  maxDepth?: number;
  includeRelated?: boolean;
}
```

## 9.9. 검색 결과

```typescript
interface SearchResult {
  documentId: string;
  path: string;

  title: string;
  snippet: string;

  score: number;

  sourceIds: string[];
  matchedSections: string[];

  tokenCount: number;
}
```

## 9.10. Context Builder

Context Builder는 검색 결과를 실제 LLM 컨텍스트로 변환한다.

처리 순서:

1. 후보 문서 수집
2. 중복 제거
3. 관련성 순위 결정
4. 토큰 수 추정
5. 예산 내 문서 선택
6. 필요한 Section 읽기
7. 출처 추가
8. 결과 반환

## 9.11. Token Budget

기본 설정:

```yaml
retrieval:
  default_mode: hybrid

  max_results: 10
  max_tokens: 4000

  max_depth: 5

  include_related: true
  include_sources: true
```

토큰 한도는 반환할 컨텍스트의 최대 크기다.

응답 메타데이터 및 출처 정보에 사용할 예산도 고려해야 한다.

## 9.12. 검색 실패 처리

검색 결과가 없는 경우:

- 빈 결과 반환
- 검색한 범위 표시
- 사용한 검색 방식 표시
- 유사한 카테고리 제안

검색 결과가 불충분한 경우:

- 낮은 신뢰도를 표시
- 관련 경로만 반환
- 검색 범위 확대를 제안

검색 결과에 없는 사실을 만들어 반환하지 않는다.

---

# 10. SQLite 데이터베이스 설계

## 10.1. 기본 테이블

```text
projects
sources
source_sections
documents
categories
document_sources
document_relations
document_versions
build_jobs
search_history
embedding_metadata
```

## 10.2. projects

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

## 10.3. documents

```sql
CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,

    path TEXT NOT NULL,
    title TEXT NOT NULL,

    category_id TEXT,
    depth INTEGER NOT NULL,

    content_hash TEXT NOT NULL,
    status TEXT NOT NULL,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    UNIQUE(project_id, path),

    FOREIGN KEY(project_id)
        REFERENCES projects(id)
);
```

## 10.4. categories

```sql
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,

    parent_id TEXT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,

    depth INTEGER NOT NULL,

    FOREIGN KEY(project_id)
        REFERENCES projects(id),

    FOREIGN KEY(parent_id)
        REFERENCES categories(id)
);
```

## 10.5. document_relations

```sql
CREATE TABLE document_relations (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,

    relation_type TEXT NOT NULL,

    PRIMARY KEY (
        source_id,
        target_id,
        relation_type
    )
);
```

## 10.6. FTS 인덱스

```sql
CREATE VIRTUAL TABLE document_fts
USING fts5(
    document_id UNINDEXED,
    title,
    path,
    tags,
    content
);
```

FTS 인덱스는 Markdown 파일의 내용을 기반으로 재생성할 수 있어야 한다.

검색 결과와 실제 파일 내용이 불일치하면 인덱스 동기화를 수행한다.

## 10.7. 무결성

SQLite는 다음 규칙을 적용한다.

- Foreign Key 활성화
- 트랜잭션 사용
- 스키마 마이그레이션
- 인덱스 검증
- DB 백업
- 손상 시 재구축

문서 데이터의 최종 원본은 Markdown이다.

---

# 11. Incremental Update

## 11.1. 목적

원본 문서가 변경되어도 전체 지식 저장소를 다시 생성하지 않는다.

## 11.2. 변경 감지

각 원본 파일과 Section의 SHA-256 해시를 비교한다.

변경 유형:

- Added
- Modified
- Deleted
- Unchanged

## 11.3. 영향 분석

변경된 Section과 연결된 생성 문서를 찾는다.

이후 해당 문서를 참조하는 상위 index와 관련 문서를 검사한다.

```text
Source Changed
      |
      v
Hash Comparison
      |
      v
Changed Sections
      |
      v
Affected Documents
      |
      v
Dependency Analysis
      |
      v
Regeneration Plan
      |
      v
Preview
      |
      v
Commit
```

## 11.4. 문서 충돌 처리

사용자가 직접 수정한 문서를 AI가 재생성하려는 경우 충돌을 표시한다.

선택 가능한 작업:

1. 기존 문서 유지
2. AI 생성 결과 적용
3. 변경 사항 비교
4. 수동 병합
5. 해당 문서 업데이트 제외

기본값은 기존 사용자 수정 내용 보호다.

## 11.5. 구조 변경

카테고리가 변경될 경우 문서 이동 계획을 생성한다.

문서 ID는 가능한 한 유지한다.

이동된 경로를 참조하는 내부 링크도 함께 갱신한다.

삭제 예정 문서는 사용자 승인 없이 즉시 삭제하지 않는다.

---

# 12. MCP Server

## 12.1. 목적

외부 AI 애플리케이션이 quick-llm-memory의 지식을 탐색할 수 있도록 한다.

## 12.2. 지원 Transport

- stdio
- Streamable HTTP

기본 Transport는 stdio다.

HTTP 서버는 선택적으로 활성화한다.

## 12.3. stdio 서버

실행 명령:

```bash
qlm mcp serve --transport stdio
```

stdio 서버는 MCP 클라이언트가 실행하고 프로세스 수명을 관리한다.

표준 출력(stdout)은 MCP 프로토콜 전용으로 사용한다.

일반 로그는 stderr 또는 로그 파일에 출력한다.

## 12.4. HTTP 서버

실행 명령:

```bash
qlm mcp serve \
  --transport http \
  --host 127.0.0.1 \
  --port 8765
```

기본 주소:

```text
http://127.0.0.1:8765/mcp
```

HTTP 서버는 여러 MCP 클라이언트의 연결을 처리할 수 있어야 한다.

기본적으로 외부 네트워크 연결을 허용하지 않는다.

## 12.5. MCP Tools

### memory_list_projects

사용 가능한 프로젝트 목록을 조회한다.

입력:

```json
{}
```

### memory_get_tree

프로젝트의 지식 계층을 조회한다.

입력:

```json
{
  "project": "gsm-sv",
  "path": "security",
  "max_depth": 2
}
```

반환 정보:

- 카테고리
- 하위 카테고리
- 문서
- 설명
- 상대 경로

### memory_search

지식을 검색한다.

입력:

```json
{
  "project": "gsm-sv",
  "query": "VM 생성 권한",
  "mode": "hybrid",
  "max_results": 5
}
```

### memory_read

특정 문서를 읽는다.

입력:

```json
{
  "project": "gsm-sv",
  "path": "security/vm/create.md"
}
```

### memory_read_many

여러 문서를 읽는다.

입력:

```json
{
  "project": "gsm-sv",
  "paths": [
    "security/vm/create.md",
    "security/authorization.md"
  ],
  "max_tokens": 4000
}
```

### memory_get_context

질문에 필요한 컨텍스트를 자동 구성한다.

입력:

```json
{
  "project": "gsm-sv",
  "query": "VM 생성 API 구현에 필요한 명세",
  "max_tokens": 3000
}
```

### memory_get_related

문서와 연결된 관련 문서를 조회한다.

입력:

```json
{
  "project": "gsm-sv",
  "path": "security/vm/create.md"
}
```

### memory_get_metadata

문서의 메타데이터를 반환한다.

### memory_validate

프로젝트 지식 저장소의 무결성을 확인한다.

기본적으로 읽기 및 검사만 수행한다.

## 12.6. MCP Resources

다음 형식의 URI를 사용한다.

```text
qlm://gsm-sv/index.md
qlm://gsm-sv/security/index.md
qlm://gsm-sv/security/vm/create.md
```

Resource URI는 논리적인 문서 식별자다.

로컬 파일의 실제 절대 경로를 외부에 노출하지 않는다.

## 12.7. MCP Prompts

다음 Prompt를 제공한다.

- explore-project
- find-implementation-context
- explain-architecture
- review-specification
- identify-dependencies

Prompt는 필요한 MCP Tool을 활용하도록 AI에 탐색 절차를 안내한다.

## 12.8. MCP 쓰기 기능

기본 모드:

```yaml
mcp:
  access: read-only
```

선택적 쓰기 모드:

```yaml
mcp:
  access: approval-required
```

쓰기 기능:

- memory_create_document
- memory_update_document
- memory_propose_structure
- memory_add_relation

쓰기 요청은 즉시 적용하지 않는다.

변경 내용을 임시 저장하고 TUI에서 승인받는다.

HTTP 원격 연결 환경에서는 별도의 인증 및 권한 검증을 요구한다.

## 12.9. MCP 클라이언트 설정

기본 stdio 설정 예시:

```json
{
  "mcpServers": {
    "quick-llm-memory": {
      "command": "qlm",
      "args": [
        "mcp",
        "serve",
        "--transport",
        "stdio"
      ]
    }
  }
}
```

클라이언트마다 설정 파일 형식이 다를 수 있으므로 별도 Adapter를 제공한다.

지원 대상:

- Claude Code
- Cursor
- VS Code 기반 MCP 클라이언트
- 기타 표준 MCP 호환 클라이언트

실제 연결 전에 해당 클라이언트의 지원 기능과 설정 형식을 확인한다.

---

# 13. MCP Manager

## 13.1. 기능

- MCP 서버 설정
- stdio 실행 명령 표시
- HTTP 서버 시작
- HTTP 서버 종료
- 연결 상태 확인
- 클라이언트 설정 생성
- Tool 활성화 관리
- 로그 확인

## 13.2. MCP 상태

```text
DISABLED
CONFIGURED
STARTING
RUNNING
STOPPING
STOPPED
ERROR
```

stdio 방식에서는 클라이언트가 서버를 직접 실행하므로 TUI에서 서버의 실제 상주 여부를 보장할 수 없다.

따라서 다음 상태를 별도로 표시한다.

```text
stdio:
  integration: enabled
  process: client-managed
```

HTTP 방식에서는 실제 프로세스의 실행 상태를 관리한다.

## 13.3. 프로세스 관리

HTTP 서버를 백그라운드로 실행할 경우 다음 정보를 기록한다.

- Process ID
- 시작 시간
- 호스트
- 포트
- 실행 설정
- 로그 경로

PID만으로 프로세스를 식별하지 않는다.

시작 시간 및 프로세스 식별 정보를 함께 확인해 다른 프로세스를 잘못 종료하지 않도록 한다.

## 13.4. 서버 종료

정상 종료 절차:

1. 신규 연결 차단
2. 진행 중인 요청 종료 대기
3. 최대 대기 시간 확인
4. 데이터베이스 정리
5. HTTP 서버 종료
6. 런타임 상태 갱신

강제 종료는 정상 종료에 실패했을 때만 사용한다.

---

# 14. TUI 설계

## 14.1. 기본 구조

TUI는 Ink와 React를 사용한다.

화면은 다음 영역으로 분리한다.

```text
+----------------------------------------------------------+
| quick-llm-memory                                v1.0.0   |
+----------------------------------------------------------+
|                                                          |
| Navigation         | Main Content                        |
|                    |                                     |
| > Dashboard        | Project: gsm-sv                     |
|   Projects         |                                     |
|   Build            | Documents: 128                      |
|   Explorer         | Categories: 24                      |
|   Search           | Maximum Depth: 4                    |
|   MCP Manager      |                                     |
|   Settings         | MCP: Enabled                        |
|   Logs             |                                     |
|                    |                                     |
+----------------------------------------------------------+
| ↑↓ Navigate  Enter Select  Esc Back  / Search  q Quit     |
+----------------------------------------------------------+
```

## 14.2. 주요 화면

### Screen 1. Dashboard

표시 정보:

- 등록된 프로젝트 수
- 최근 프로젝트
- 전체 문서 수
- 전체 카테고리 수
- MCP 상태
- 최근 생성 작업
- 최근 오류

### Screen 2. Projects

기능:

- 프로젝트 생성
- 프로젝트 선택
- 프로젝트 이름 변경
- 프로젝트 보관
- 프로젝트 삭제
- 프로젝트 가져오기
- 프로젝트 내보내기

### Screen 3. Create Wizard

단계:

```text
1. Project Name
2. Input Sources
3. AI Provider
4. AI Model
5. Hierarchy Settings
6. Document Settings
7. Analysis
8. Structure Preview
9. Confirmation
10. Generation
11. Validation
12. Complete
```

각 단계는 이전 단계로 돌아갈 수 있어야 한다.

### Screen 4. Tree Explorer

기능:

- 디렉터리 확장 및 축소
- Depth별 탐색
- 문서 선택
- 문서 내용 열람
- 관련 문서 이동
- 문서 경로 복사
- 파일을 외부 편집기로 열기

### Screen 5. Search

기능:

- 검색어 입력
- 검색 방식 선택
- 프로젝트 범위 선택
- 검색 결과 목록
- 결과 미리보기
- 관련성 점수
- 원본 문서 확인

### Screen 6. MCP Manager

기능:

- MCP 활성화 설정
- Transport 선택
- 서버 시작 및 종료
- 클라이언트 연결 안내
- Tool 목록
- 실행 로그
- 연결 테스트

### Screen 7. Settings

설정 항목:

- AI Provider
- AI Model
- Embedding Provider
- 기본 Depth
- 최대 문서 토큰
- 검색 토큰 예산
- 동시 실행 개수
- 비용 제한
- 로그 수준
- 색상 테마
- 키 바인딩

### Screen 8. Logs

- 작업별 로그 조회
- 오류 필터링
- MCP 로그 확인
- 로그 파일 경로 열기
- 민감 정보 제거 후 로그 내보내기

## 14.3. 키보드 조작

| Key | Action |
|---|---|
| ↑ / ↓ | 항목 이동 |
| ← / → | 트리 접기/펼치기 |
| Enter | 선택 |
| Esc | 뒤로 |
| Tab | 패널 전환 |
| / | 검색 |
| Ctrl+P | 프로젝트 선택 |
| Ctrl+B | Build |
| Ctrl+M | MCP Manager |
| Ctrl+R | 새로고침 |
| Ctrl+S | 저장 |
| ? | 도움말 |
| q | 종료 |

키 바인딩은 사용자 설정으로 변경할 수 있다.

## 14.4. 화면 크기 대응

TUI는 터미널 크기에 따라 레이아웃을 변경한다.

- 넓은 터미널: 좌우 분할 레이아웃
- 좁은 터미널: 단일 패널 레이아웃
- 너무 작은 터미널: 최소 크기 안내

화면 크기 변경 시 UI를 다시 렌더링한다.

## 14.5. 접근성

- 키보드만으로 전체 기능 사용
- 색상 이외의 상태 표현 제공
- 고대비 테마
- 컬러 출력 비활성화
- 터미널 호환성 검사

---

# 15. CLI 설계

## 15.1. 기본 명령

```bash
qlm
```

TUI를 실행한다.

```bash
qlm --help
```

CLI 도움말을 표시한다.

```bash
qlm --version
```

버전을 표시한다.

## 15.2. 프로젝트 관리

```bash
qlm init <name>
qlm project list
qlm project info <name>
qlm project remove <name>
qlm project export <name>
qlm project import <path>
```

삭제 명령은 확인 절차를 수행한다.

비대화형 실행에서는 명시적 확인 옵션이 필요하다.

## 15.3. 지식 생성

```bash
qlm build <source>
qlm build <source> --project <name>
qlm build <source> --depth 5
qlm build <source> --dry-run
qlm build <source> --yes
```

`--dry-run`은 실제 파일을 변경하지 않고 예상 결과만 출력한다.

## 15.4. 문서 탐색

```bash
qlm tree
qlm tree security
qlm tree --depth 3

qlm read security/vm/create.md

qlm search "VM 생성 권한"
qlm search "VM 생성 권한" --mode hybrid
```

## 15.5. 관리 명령

```bash
qlm validate
qlm reindex
qlm update
qlm status
qlm doctor
```

## 15.6. MCP 명령

```bash
qlm mcp serve --transport stdio

qlm mcp serve --transport http

qlm mcp start
qlm mcp stop
qlm mcp status

qlm mcp tools
qlm mcp config
qlm mcp test
```

`start`, `stop`, `status`는 기본적으로 관리형 HTTP 서버를 대상으로 한다.

stdio 서버는 `serve` 명령으로 실행한다.

## 15.7. 자동화 출력

CLI는 JSON 출력 옵션을 제공한다.

```bash
qlm search "authentication" --json
```

JSON 출력은 다른 프로그램에서 사용할 수 있도록 안정적인 스키마를 유지한다.

자동화 환경에서는 TUI를 실행하지 않는다.

---

# 16. 설정 시스템

## 16.1. 전역 설정

```yaml
application:
  name: quick-llm-memory
  language: ko
  theme: dark

storage:
  mode: local
  auto_backup: true

ai:
  provider: openai
  model: configured-model
  concurrency: 3

  retry:
    max_attempts: 3

  budget:
    enabled: true
    max_cost_usd: 2.0

knowledge:
  hierarchy:
    max_depth: 5
    auto_depth: true

  document:
    target_tokens: 1000
    max_tokens: 2000

retrieval:
  mode: hybrid
  max_results: 10
  max_tokens: 4000

mcp:
  transport: stdio
  access: read-only

  http:
    host: 127.0.0.1
    port: 8765

logging:
  level: info
```

## 16.2. 설정 우선순위

설정 우선순위는 다음과 같다.

```text
CLI Arguments
    >
Environment Variables
    >
Project Configuration
    >
Global Configuration
    >
Default Values
```

## 16.3. 설정 검증

Zod를 사용하여 설정을 검증한다.

잘못된 설정이 발견되면 해당 항목과 올바른 형식을 안내한다.

설정 파일을 자동 수정할 경우 백업을 생성한다.

---

# 17. 보안 설계

## 17.1. 파일 접근 제한

모든 파일 접근은 프로젝트별 허용 경로로 제한한다.

다음 공격을 방지한다.

- Path Traversal
- Symlink Escape
- 임의 절대 경로 접근
- 비인가 파일 수정
- 악의적인 파일명

경로 문자열 검증과 함께 실제 파일 시스템 경로를 확인한다.

## 17.2. API Key 보호

- 로그 출력 금지
- MCP 응답 노출 금지
- TUI에서 마스킹
- 환경변수 지원
- OS 보안 저장소 지원

## 17.3. AI 입력 보안

문서에 포함된 명령문은 신뢰할 수 없는 데이터로 취급한다.

AI가 원본 문서의 내용을 시스템 지침처럼 실행하지 않도록 Prompt 경계를 명확하게 분리한다.

AI 생성 결과는 명령 실행 권한을 갖지 않는다.

## 17.4. HTTP 보안

- 기본 localhost 바인딩
- Origin 검증
- 인증 기능
- 요청 크기 제한
- 동시 요청 제한
- 요청 타임아웃
- 접근 로그
- Rate Limiting

외부 네트워크 접근을 허용하려면 사용자에게 명시적인 확인을 요구한다.

## 17.5. MCP 권한

MCP Tool은 기능별 권한을 가진다.

```text
READ
SEARCH
METADATA
PROPOSE_WRITE
APPROVED_WRITE
ADMIN
```

최초 설치 시 READ, SEARCH, METADATA만 활성화한다.

## 17.6. 원본 데이터 보호

AI Provider로 전송할 수 있는 문서 범위를 사용자가 확인할 수 있어야 한다.

비밀키, 인증 토큰, 비밀번호 등 민감 정보의 전송을 줄이기 위한 사전 탐지 및 마스킹 기능을 제공한다.

단, 자동 탐지가 모든 민감 정보를 찾는다고 보장해서는 안 된다.

---

# 18. 백업 및 복구

## 18.1. 백업 대상

- Markdown 지식 저장소
- 프로젝트 설정
- 원본 자료 메타데이터
- 문서 관계 정보
- 생성 이력

SQLite 검색 인덱스는 복구 후 재구축할 수 있다.

## 18.2. Snapshot

다음 작업 전 Snapshot을 생성한다.

- 대규모 문서 재생성
- 계층 구조 변경
- 문서 일괄 이동
- 삭제
- 프로젝트 마이그레이션

## 18.3. 복원

```bash
qlm snapshot list
qlm snapshot create
qlm snapshot restore <id>
```

복원은 기존 상태의 백업을 먼저 만든 뒤 수행한다.

## 18.4. 원자적 저장

새로운 지식 구조는 임시 디렉터리에 생성한다.

검증 완료 후 프로젝트 저장소에 반영한다.

반영 도중 오류가 발생하면 기존 상태를 복구한다.

파일 시스템과 SQLite 변경을 함께 관리하기 위한 Commit Journal을 사용한다.

---

# 19. 오류 처리

## 19.1. 오류 분류

```text
QLM_CONFIG_ERROR
QLM_INPUT_ERROR
QLM_PARSE_ERROR
QLM_AI_ERROR
QLM_RATE_LIMIT
QLM_SCHEMA_ERROR
QLM_STORAGE_ERROR
QLM_INDEX_ERROR
QLM_MCP_ERROR
QLM_PERMISSION_ERROR
QLM_CONFLICT_ERROR
QLM_INTERNAL_ERROR
```

## 19.2. 오류 응답

각 오류는 다음 정보를 포함한다.

```typescript
interface QLMError {
  code: string;
  message: string;

  details?: unknown;

  retryable: boolean;
  suggestedAction?: string;
}
```

## 19.3. 실패 복구

- AI 요청 실패: 제한된 횟수 재시도
- 구조 검증 실패: 수정 또는 재생성
- 파일 저장 실패: Commit 취소
- SQLite 오류: 백업 확인 및 재구축
- MCP 오류: 연결 종료 및 로그 기록
- 사용자 취소: 안전한 중단

---

# 20. 성능 요구사항

## 20.1. 목표

다음 값은 최종 제품의 성능 목표이며, 실제 벤치마크로 검증한다.

| 항목 | 목표 |
|---|---|
| TUI 최초 화면 | 2초 이내 |
| 일반 문서 열람 | 200ms 이내 |
| 로컬 키워드 검색 | 500ms 이내 |
| 트리 조회 | 200ms 이내 |
| MCP 일반 읽기 요청 | 500ms 이내 |
| 1만 문서 인덱싱 | 별도 벤치마크 기준 수립 |
| 검색 결과 토큰 제한 | 설정값 준수 |
| 데이터 손상 방지 | 원자적 반영 |

성능 측정 환경은 별도 벤치마크 문서에서 정의한다.

AI API 호출이 필요한 작업은 네트워크 및 Provider 응답 시간에 영향을 받으므로 별도 측정한다.

## 20.2. 확장성

최종 제품은 다음 규모를 목표로 설계한다.

- 프로젝트 100개 이상
- 프로젝트당 문서 10,000개 이상
- 다중 MCP 클라이언트
- 장시간 백그라운드 작업
- 수백 MB 이상의 원본 문서 집합

이는 지원을 위한 설계 목표이며 실제 검증 결과와 구분한다.

---

# 21. 로깅 및 관측성

## 21.1. 로그 수준

- trace
- debug
- info
- warn
- error
- fatal

## 21.2. 주요 로그

- 프로젝트 생성
- 문서 파싱
- AI 요청
- 구조 생성
- 문서 저장
- 검색 실행
- MCP 연결
- 권한 거부
- 백업 및 복원
- 오류

## 21.3. AI 사용량

다음 정보를 기록한다.

- Provider
- Model
- 입력 토큰
- 출력 토큰
- 요청 시간
- 성공 여부
- 예상 또는 실제 비용

민감한 Prompt 전문은 기본적으로 저장하지 않는다.

## 21.4. 성능 측정

다음 지표를 수집한다.

- 검색 소요 시간
- 문서 읽기 소요 시간
- 인덱스 생성 시간
- AI 생성 시간
- 반환 토큰 수
- 검색 결과 수
- 오류율

---

# 22. 테스트 설계

## 22.1. 단위 테스트

대상:

- Path Validator
- Markdown Parser
- Hierarchy Validator
- Token Budget
- Search Ranker
- Configuration Loader
- Document Generator
- Metadata Parser

## 22.2. 통합 테스트

대상:

- 입력 문서에서 지식 생성
- 생성 후 검색
- 파일 변경 후 재인덱싱
- AI 생성 결과 검증
- MCP Tool 호출
- HTTP 서버 연결
- Snapshot 복원

## 22.3. MCP 테스트

공식 MCP Inspector 및 자동화된 MCP Client 테스트를 사용한다.

검증 항목:

- 초기 연결
- Tool 목록
- Resource 목록
- Tool 호출
- 잘못된 인자
- 존재하지 않는 문서
- 권한 거부
- 연결 종료
- 다중 클라이언트 연결

## 22.4. 검색 품질 테스트

질문과 정답 문서가 연결된 평가 데이터셋을 구축한다.

평가 지표:

- Recall@K
- Precision@K
- MRR
- nDCG
- 검색 지연 시간
- 반환 토큰 수
- 정답 문서 누락률

## 22.5. AI 지식 생성 평가

평가 항목:

- 원본 내용 보존율
- 잘못된 사실 생성 비율
- 카테고리 적절성
- 중복 문서 비율
- 출처 연결 정확도
- 문서 관계 정확도
- 업데이트 후 일관성

AI 생성 결과를 정답으로 간주하지 않는다.

## 22.6. 보안 테스트

- `../` 경로 입력
- 심볼릭 링크 우회
- 악의적인 Markdown
- Prompt Injection
- API Key 노출
- 대용량 요청
- 무단 MCP 쓰기
- HTTP 인증 우회
- 동시 요청 과부하

---

# 23. 배포 설계

## 23.1. npm 패키지

패키지명:

```text
quick-llm-memory
```

실행 명령:

```bash
npx quick-llm-memory
```

전역 설치:

```bash
npm install -g quick-llm-memory
```

설치 후:

```bash
qlm
```

패키지명 사용 가능 여부는 실제 배포 전에 확인한다.

## 23.2. 독립 실행 파일

최종적으로 운영체제별 실행 파일을 제공한다.

```text
qlm-windows-x64.exe
qlm-windows-arm64.exe

qlm-macos-arm64
qlm-macos-x64

qlm-linux-x64
qlm-linux-arm64
```

독립 실행 파일은 Node.js 런타임을 별도로 설치하지 않아도 실행할 수 있도록 패키징한다.

네이티브 SQLite 모듈과 터미널 렌더링 호환성을 검증한다.

## 23.3. GitHub Releases

각 릴리스에 다음 파일을 제공한다.

- 실행 파일
- 체크섬
- 변경 사항
- 설치 안내
- 지원 플랫폼
- 알려진 문제

## 23.4. CI/CD

GitHub Actions를 사용한다.

파이프라인:

```text
Push / Pull Request
        |
        v
Install Dependencies
        |
        v
Type Check
        |
        v
Lint
        |
        v
Unit Tests
        |
        v
Integration Tests
        |
        v
Build
        |
        v
Package
        |
        v
Release
```

릴리스 과정에서 실행 파일의 체크섬을 생성한다.

---

# 24. 소스 코드 디렉터리 구조

```text
quick-llm-memory/
├── src/
│   ├── index.ts
│   │
│   ├── cli/
│   │   ├── index.ts
│   │   ├── commands/
│   │   │   ├── init.ts
│   │   │   ├── build.ts
│   │   │   ├── update.ts
│   │   │   ├── search.ts
│   │   │   ├── read.ts
│   │   │   ├── tree.ts
│   │   │   ├── validate.ts
│   │   │   ├── reindex.ts
│   │   │   └── mcp.ts
│   │   └── output/
│   │
│   ├── tui/
│   │   ├── app.tsx
│   │   ├── screens/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Projects.tsx
│   │   │   ├── CreateWizard.tsx
│   │   │   ├── TreeExplorer.tsx
│   │   │   ├── DocumentViewer.tsx
│   │   │   ├── Search.tsx
│   │   │   ├── MCPManager.tsx
│   │   │   ├── Settings.tsx
│   │   │   └── Logs.tsx
│   │   │
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── themes/
│   │   └── navigation/
│   │
│   ├── application/
│   │   ├── ProjectService.ts
│   │   ├── BuildService.ts
│   │   ├── SearchService.ts
│   │   ├── MCPService.ts
│   │   └── BackupService.ts
│   │
│   ├── core/
│   │   ├── builder/
│   │   │   ├── SourceLoader.ts
│   │   │   ├── SectionExtractor.ts
│   │   │   ├── HierarchyPlanner.ts
│   │   │   ├── HierarchyValidator.ts
│   │   │   ├── DocumentGenerator.ts
│   │   │   └── BuildPipeline.ts
│   │   │
│   │   ├── parser/
│   │   │   ├── MarkdownParser.ts
│   │   │   ├── TextParser.ts
│   │   │   ├── PDFParser.ts
│   │   │   ├── DOCXParser.ts
│   │   │   ├── HTMLParser.ts
│   │   │   └── RepositoryParser.ts
│   │   │
│   │   ├── retrieval/
│   │   │   ├── RetrievalEngine.ts
│   │   │   ├── HierarchicalSearch.ts
│   │   │   ├── FullTextSearch.ts
│   │   │   ├── SemanticSearch.ts
│   │   │   ├── HybridSearch.ts
│   │   │   ├── ContextBuilder.ts
│   │   │   └── TokenBudget.ts
│   │   │
│   │   ├── storage/
│   │   │   ├── MarkdownRepository.ts
│   │   │   ├── SQLiteRepository.ts
│   │   │   ├── SnapshotManager.ts
│   │   │   └── TransactionManager.ts
│   │   │
│   │   ├── indexing/
│   │   │   ├── IndexBuilder.ts
│   │   │   ├── FTSIndexer.ts
│   │   │   └── VectorIndexer.ts
│   │   │
│   │   ├── updates/
│   │   │   ├── ChangeDetector.ts
│   │   │   ├── ImpactAnalyzer.ts
│   │   │   ├── ConflictResolver.ts
│   │   │   └── IncrementalUpdater.ts
│   │   │
│   │   └── validation/
│   │       ├── PathValidator.ts
│   │       ├── ContentValidator.ts
│   │       ├── LinkValidator.ts
│   │       └── IntegrityValidator.ts
│   │
│   ├── ai/
│   │   ├── AIProvider.ts
│   │   ├── EmbeddingProvider.ts
│   │   ├── ProviderRegistry.ts
│   │   ├── adapters/
│   │   │   ├── OpenAIProvider.ts
│   │   │   ├── AnthropicProvider.ts
│   │   │   ├── GeminiProvider.ts
│   │   │   ├── OllamaProvider.ts
│   │   │   └── CompatibleProvider.ts
│   │   └── prompts/
│   │       ├── hierarchy.ts
│   │       ├── generation.ts
│   │       ├── summary.ts
│   │       └── validation.ts
│   │
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── transports/
│   │   │   ├── stdio.ts
│   │   │   └── http.ts
│   │   ├── tools/
│   │   ├── resources/
│   │   ├── prompts/
│   │   ├── permissions/
│   │   └── clients/
│   │
│   ├── database/
│   │   ├── connection.ts
│   │   ├── migrations/
│   │   └── repositories/
│   │
│   ├── config/
│   ├── types/
│   ├── errors/
│   ├── security/
│   └── utils/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── mcp/
│   ├── security/
│   └── fixtures/
│
├── docs/
│   ├── architecture/
│   ├── specification/
│   ├── development/
│   ├── mcp/
│   └── user-guide/
│
├── scripts/
├── .github/
│   └── workflows/
│
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── eslint.config.js
├── vitest.config.ts
├── README.md
├── CONTRIBUTING.md
├── LICENSE
└── CHANGELOG.md
```

---

# 25. 개발 로드맵

## Phase 1. Project Foundation

목표:
프로젝트의 기본 실행 환경을 구축한다.

작업:

1. TypeScript 프로젝트 초기화
2. CLI Entry Point
3. Commander 설정
4. 환경 설정 로더
5. 프로젝트 디렉터리 관리
6. 오류 처리 시스템
7. 로깅 시스템
8. 기본 테스트 환경

완료 기준:

- `qlm --help` 동작
- `qlm init` 동작
- 프로젝트 목록 확인 가능
- 설정 파일 로딩 가능

## Phase 2. Markdown Storage Engine

목표:
AI 없이도 Markdown 지식 저장소를 관리할 수 있도록 한다.

작업:

1. Markdown 파일 읽기
2. Frontmatter 파싱
3. 문서 ID 관리
4. 카테고리 트리 구성
5. index.md 생성
6. 내부 링크 검증
7. SQLite 스키마 구축
8. 인덱스 재생성

완료 기준:

- Markdown 파일 저장 가능
- 트리 탐색 가능
- 문서 검색 가능
- SQLite 삭제 후 재구축 가능

## Phase 3. AI Knowledge Builder

목표:
설계 명세서로부터 자동 지식 저장소를 생성한다.

작업:

1. AI Provider 인터페이스
2. OpenAI-compatible Adapter
3. Section Extractor
4. Hierarchy Planner
5. JSON Schema 검증
6. Document Generator
7. 생성 결과 검증
8. Atomic Commit
9. 진행률 표시

완료 기준:

- 단일 Markdown 명세서 자동 분석
- 계층 구조 자동 생성
- Markdown 분할 저장
- 원본 출처 추적
- 검증 실패 시 기존 문서 보호

## Phase 4. Retrieval Engine

목표:
필요한 정보만 선택적으로 읽을 수 있도록 한다.

작업:

1. Path Search
2. Hierarchical Search
3. SQLite FTS5
4. 검색 결과 순위 결정
5. Token Budget
6. Context Builder
7. 관련 문서 탐색
8. 검색 품질 테스트

완료 기준:

- 질문 관련 문서 검색
- 토큰 제한 준수
- 출처 표시
- 전체 파일 로딩 없이 검색 가능

## Phase 5. MCP Integration

목표:
외부 AI 개발 도구와 연결한다.

작업:

1. MCP Server 생성
2. stdio Transport
3. Tool 등록
4. Resource 등록
5. Prompt 등록
6. MCP Inspector 테스트
7. 클라이언트 설정 생성
8. 읽기 권한 검증

완료 기준:

- MCP 클라이언트 연결 성공
- 문서 트리 조회 성공
- 검색 Tool 호출 성공
- 문서 읽기 성공
- 비인가 경로 접근 차단

## Phase 6. TUI

목표:
전체 기능을 터미널에서 관리할 수 있도록 한다.

작업:

1. Ink Application
2. Navigation System
3. Dashboard
4. Projects
5. Create Wizard
6. Tree Explorer
7. Document Viewer
8. Search UI
9. MCP Manager
10. Settings
11. Logs
12. 키보드 단축키

완료 기준:

- 마우스 없이 전체 기능 사용
- 프로젝트 생성부터 MCP 연결까지 TUI에서 완료
- 터미널 크기 변경 대응
- 오류와 진행률 표시

## Phase 7. Advanced AI Features

목표:
대형 프로젝트에서도 효율적인 지식 관리가 가능하도록 한다.

작업:

1. Incremental Update
2. Dependency Graph
3. Conflict Detection
4. AI 생성 캐시
5. Embedding Provider
6. Vector Search
7. Hybrid Search
8. 검색 품질 평가

완료 기준:

- 변경된 Section만 재처리
- 관련 문서 영향 분석
- 사용자 수정 보호
- 의미 검색 지원

## Phase 8. Extended MCP & Operations

목표:
MCP 서버 운영 및 고급 기능을 제공한다.

작업:

1. HTTP Transport
2. HTTP 서버 프로세스 관리
3. 다중 클라이언트 처리
4. 인증 및 권한 관리
5. 승인 기반 쓰기
6. Snapshot
7. 백업 및 복원
8. 보안 테스트

완료 기준:

- HTTP MCP 서버 실행 및 종료
- 다중 연결 처리
- 승인 없는 문서 수정 차단
- 백업 복원 검증

## Phase 9. Distribution

목표:
일반 사용자가 설치하여 사용할 수 있는 최종 제품을 출시한다.

작업:

1. 전체 테스트
2. 성능 최적화
3. 크로스 플랫폼 테스트
4. npm 패키지 배포
5. 독립 실행 파일 패키징
6. GitHub Actions
7. 사용자 문서
8. MCP 연결 가이드
9. GitHub Release

완료 기준:

- Windows/macOS/Linux 실행
- npm 설치 가능
- 독립 실행 파일 실행 가능
- 기본 기능 테스트 통과
- 사용자 가이드 완성

---

# 26. 최종 사용자 시나리오

## Scenario A. 최초 지식 저장소 생성

1. 사용자가 터미널을 실행한다.
2. `qlm` 명령어를 입력한다.
3. TUI가 실행된다.
4. Create Project를 선택한다.
5. 프로젝트 이름을 입력한다.
6. 설계 명세서를 선택한다.
7. AI Provider와 모델을 선택한다.
8. 최대 Depth와 문서 크기를 설정한다.
9. AI가 원본을 분석한다.
10. 생성할 계층 구조를 표시한다.
11. 사용자가 구조를 확인한다.
12. 사용자가 생성을 승인한다.
13. AI가 Markdown을 생성한다.
14. 시스템이 생성 결과를 검증한다.
15. 파일을 저장한다.
16. SQLite 인덱스를 생성한다.
17. 프로젝트 Dashboard를 표시한다.

## Scenario B. MCP 연결

1. TUI에서 MCP Manager를 선택한다.
2. 프로젝트를 선택한다.
3. MCP Transport를 선택한다.
4. 클라이언트 설정을 생성한다.
5. 외부 AI 도구에 설정을 등록한다.
6. MCP 클라이언트가 서버에 연결한다.
7. 외부 AI가 Tool 목록을 조회한다.
8. 필요한 문서를 검색한다.
9. 관련 문서만 반환받는다.

## Scenario C. 설계 명세서 변경

1. 사용자가 원본 설계 명세서를 수정한다.
2. `qlm update`를 실행한다.
3. 원본 해시를 비교한다.
4. 변경된 Section을 확인한다.
5. 영향받는 생성 문서를 찾는다.
6. 변경 계획을 생성한다.
7. TUI에 변경 내역을 표시한다.
8. 사용자가 승인한다.
9. 필요한 문서만 재생성한다.
10. 관련 index와 링크를 갱신한다.
11. 검색 인덱스를 갱신한다.
12. 이전 상태를 Snapshot으로 보존한다.

## Scenario D. AI의 선택적 문서 탐색

질문:

"VM 생성 API 구현에 필요한 보안 명세를 알려줘."

실행 흐름:

```text
AI Client
   |
   v
memory_search
   |
   v
Retrieval Engine
   |
   +--> Hierarchy Search
   |
   +--> Full-text Search
   |
   +--> Semantic Search
   |
   v
Result Ranking
   |
   v
Token Budget
   |
   v
Context Builder
   |
   v
Relevant Markdown
   |
   v
MCP Response
   |
   v
AI Client
```

AI는 반환된 문서와 출처를 기반으로 작업한다.

필요한 정보가 부족하면 추가 검색을 수행할 수 있다.

---

# 27. 최종 제품 완료 조건

quick-llm-memory v1.0은 다음 조건을 모두 만족해야 한다.

## 지식 생성

- [ ] 설계 명세서 입력 가능
- [ ] AI 자동 계층 생성
- [ ] 카테고리별 Markdown 분할
- [ ] Depth 설정
- [ ] 생성 구조 미리보기
- [ ] 생성 결과 검증
- [ ] 원본 출처 보존

## 지식 관리

- [ ] 프로젝트별 관리
- [ ] Markdown 수정
- [ ] 트리 탐색
- [ ] 링크 검증
- [ ] 문서 관계 관리
- [ ] 증분 업데이트
- [ ] 사용자 수정 보호

## 검색

- [ ] 경로 검색
- [ ] 계층형 검색
- [ ] 키워드 검색
- [ ] 의미 기반 검색
- [ ] 하이브리드 검색
- [ ] 토큰 예산 제한
- [ ] 검색 결과 출처 표시

## MCP

- [ ] stdio 서버
- [ ] HTTP 서버
- [ ] Tools
- [ ] Resources
- [ ] Prompts
- [ ] 읽기 전용 모드
- [ ] 승인 기반 쓰기
- [ ] 클라이언트 연결 테스트

## TUI

- [ ] Dashboard
- [ ] Project Manager
- [ ] Create Wizard
- [ ] Tree Explorer
- [ ] Document Viewer
- [ ] Search
- [ ] MCP Manager
- [ ] Settings
- [ ] Logs
- [ ] 키보드 전용 조작

## 운영

- [ ] 설정 관리
- [ ] API Key 보호
- [ ] 오류 처리
- [ ] 구조화 로그
- [ ] Snapshot
- [ ] 백업 및 복원
- [ ] SQLite 재구축
- [ ] 경로 접근 보안
- [ ] 자동 테스트

## 배포

- [ ] Windows 지원
- [ ] macOS 지원
- [ ] Linux 지원
- [ ] npm 패키지
- [ ] 독립 실행 파일
- [ ] GitHub Releases
- [ ] 사용자 문서
- [ ] 개발자 문서

---

# 28. 향후 확장 방향

최종 제품 출시 이후 다음 기능을 고려한다.

## 28.1. 팀 단위 지식 저장소

- Git 기반 동기화
- 팀원별 권한
- 공동 문서 편집
- 변경 이력 공유

## 28.2. 원격 MCP Hosting

- 원격 MCP 서버
- 사용자 인증
- 프로젝트별 접근 권한
- TLS
- 다중 사용자 지원

## 28.3. AI Agent Integration

- 코드 변경 기반 지식 갱신 제안
- Pull Request 분석
- 프로젝트 구조 변경 감지
- 관련 명세 자동 탐색
- AI Agent별 Context Profile

## 28.4. 지식 품질 분석

- 오래된 문서 탐지
- 중복 지식 정리
- 모순된 요구사항 탐지
- 누락된 설계 영역 확인
- 문서 품질 점수

## 28.5. Retrieval Optimization

- 검색 패턴 분석
- 빈번하게 함께 읽는 문서 추천
- 문서 계층 재구성 제안
- Token Budget 자동 조정
- 검색 품질 자동 평가

---

# 29. 핵심 설계 결정

## D-001. Markdown First

Markdown을 지식 저장소의 원본으로 사용한다.

이유:

- 사람이 직접 읽고 수정할 수 있다.
- Git으로 버전 관리할 수 있다.
- 특정 데이터베이스에 종속되지 않는다.
- 다른 AI 도구에서도 재사용하기 쉽다.

## D-002. SQLite as Index

SQLite는 검색과 메타데이터를 관리한다.

Markdown 파일의 내용을 대체하지 않는다.

## D-003. Hierarchical Knowledge

상위 카테고리는 하위 구조를 안내한다.

상세 내용은 개별 문서에 저장한다.

## D-004. Selective Retrieval

모든 문서를 한 번에 읽지 않는다.

검색과 계층 탐색을 이용하여 필요한 정보만 반환한다.

## D-005. AI-assisted Generation

AI는 지식 구조 및 문서 생성을 지원한다.

파일 저장, 검증 및 권한 관리는 결정적인 프로그램 로직으로 처리한다.

## D-006. Local-first

사용자 지식은 기본적으로 로컬에 보관한다.

AI Provider를 사용하는 경우에만 필요한 자료를 외부 API로 전송한다.

## D-007. MCP Integration

외부 AI 도구는 MCP를 통해 지식에 접근한다.

내부 구현을 외부 도구에 직접 노출하지 않는다.

## D-008. TUI-first

초기 제품부터 최종 제품까지 TUI를 기본 인터페이스로 사용한다.

CLI는 자동화와 스크립트 연동을 담당한다.

## D-009. Safe Updates

기존 사용자 데이터를 보호하고 변경 전 미리보기와 복원 기능을 제공한다.

## D-010. Provider Independence

특정 AI Provider 또는 특정 MCP 클라이언트에 종속되지 않는 구조를 유지한다.

---

# 30. 최종 결론

quick-llm-memory는 단순한 Markdown 자동 분할 도구가 아니다.

프로젝트의 설계 문서와 기술 지식을 계층적으로 구조화하고, AI가 현재 작업에 필요한 정보만 선택적으로 탐색하도록 지원하는 지식 관리 시스템이다.

최종 제품은 다음 세 가지 핵심 엔진을 중심으로 동작한다.

1. Knowledge Builder
   - 입력 자료를 분석한다.
   - 계층 구조를 설계한다.
   - Markdown 지식을 자동 생성한다.

2. Retrieval Engine
   - 카테고리 구조를 탐색한다.
   - 관련 문서를 검색한다.
   - 토큰 예산 내에서 필요한 정보만 반환한다.

3. MCP Server
   - 지식 저장소를 외부 AI 도구에 연결한다.
   - 검색 및 문서 조회 기능을 제공한다.
   - 안전한 접근 제어를 수행한다.

TUI와 CLI는 이러한 엔진을 관리하는 인터페이스로 제공한다.

최종적으로 사용자는 설계 명세서 또는 프로젝트 자료를 입력하는 것만으로 구조화된 지식 저장소를 생성하고, 여러 AI 개발 도구에서 동일한 지식을 효율적으로 사용할 수 있어야 한다.

quick-llm-memory의 최종 목표는 다음과 같다.

"Store knowledge hierarchically. Retrieve only what matters."

계층적으로 지식을 저장하고, 필요한 정보만 읽는다.
