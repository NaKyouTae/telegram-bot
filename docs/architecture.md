# 서비스 아키텍처

## 개요

코인 스카우터(Coin Scouter)는 국내외 8개 거래소 공지사항을 실시간 감지하여 텔레그램 채널에 자동 알림을 보내는 서비스입니다.

## 채널

- 텔레그램: `@coin_scouter`

## 지원 거래소

| 거래소 | API | 언어 |
|--------|-----|------|
| 업비트 (Upbit) | `api-manager.upbit.com/api/v1/announcements` | 한국어 |
| 빗썸 (Bithumb) | `feed-api.bithumb.com/v1/notices` | 한국어 |
| 바이낸스 (Binance) | `binance.com/bapi/composite/v1/public/cms/article/list/query` | 영어 |
| OKX | `okx.com/api/v5/support/announcements` | 영어 |
| 코인원 (Coinone) | `coinone.co.kr/api/talk/notice/` | 한국어 |
| 비트겟 (Bitget) | `api.bitget.com/api/v2/public/annoucements` | 영어 |
| 바이비트 (Bybit) | `api.bybit.com/v5/announcements/index` | 영어 |
| 코인베이스 (Coinbase) | `status.coinbase.com/api/v2/incidents.json` | 영어 (상태/장애만) |

> 코인베이스는 공지사항 API가 없어 상태/장애 API로 대체

## 동작 방식

1. 서버 시작 시 8개 거래소 기존 공지를 DB에 저장 (알림 없음)
2. 30초마다 모든 거래소 API 폴링
3. 새 공지 발견 시 키워드 기반 카테고리 자동 분류
4. DB에 저장 + 텔레그램 채널에 알림 전송

## 기술 스택

| 구성 | 기술 |
|------|------|
| 프레임워크 | NestJS |
| 언어 | TypeScript |
| DB | PostgreSQL (Supabase) |
| ORM | TypeORM |
| 텔레그램 | Telegraf |
| 스케줄링 | @nestjs/schedule (Cron) |

## 프로젝트 구조

```
src/
├── app.module.ts
├── main.ts
├── database/
│   ├── database.module.ts
│   └── entities/
│       └── notice.entity.ts
├── classifier/
│   ├── classifier.module.ts
│   └── classifier.service.ts
├── telegram/
│   ├── telegram.module.ts
│   └── telegram.service.ts
├── upbit/
│   ├── upbit.module.ts
│   ├── upbit.service.ts
│   └── upbit.controller.ts
├── bithumb/
│   ├── bithumb.module.ts
│   ├── bithumb.service.ts
│   └── bithumb.controller.ts
├── binance/
│   ├── binance.module.ts
│   └── binance.service.ts
├── okx/
│   ├── okx.module.ts
│   └── okx.service.ts
├── coinone/
│   ├── coinone.module.ts
│   └── coinone.service.ts
├── bitget/
│   ├── bitget.module.ts
│   └── bitget.service.ts
├── bybit/
│   ├── bybit.module.ts
│   └── bybit.service.ts
├── coinbase/
│   ├── coinbase.module.ts
│   └── coinbase.service.ts
└── health/
    └── health.module.ts
```

## 환경변수

| 변수 | 설명 | 예시 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 연결 URL | `postgresql://user:pass@host:5432/db` |
| `TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 | BotFather에서 발급 |
| `TELEGRAM_CHAT_ID` | 알림 대상 채널 | `@coin_scouter` |
| `NODE_ENV` | 환경 구분 | `production` |
| `PORT` | 서버 포트 | `10000` |
