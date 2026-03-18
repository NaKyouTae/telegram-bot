import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

export enum Exchange {
  UPBIT = 'upbit',
  BITHUMB = 'bithumb',
  BINANCE = 'binance',
  OKX = 'okx',
  COINONE = 'coinone',
  BITGET = 'bitget',
  BYBIT = 'bybit',
  COINBASE = 'coinbase',
}

export enum NoticeCategory {
  LISTING = 'listing', // 신규 상장
  MARKET_ADD = 'market_add', // 원화 마켓 추가, 거래 페어 추가
  DELIST_WARNING = 'delist_warning', // 거래유의종목 지정
  DELIST_WARNING_RELEASE = 'delist_warning_release', // 유의종목 해제
  DELIST = 'delist', // 거래 지원 종료 (상폐)
  DEPOSIT_SUSPEND = 'deposit_suspend', // 입출금 중단
  DEPOSIT_RESUME = 'deposit_resume', // 입출금 재개
  NETWORK = 'network', // 네트워크 전환/업그레이드
  AIRDROP = 'airdrop', // 에어드랍
  EVENT = 'event', // 이벤트/프로모션
  STAKING = 'staking', // 스테이킹/락업
  ETC = 'etc', // 기타
}

@Entity()
@Unique(['exchange', 'externalId'])
export class Notice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar' })
  exchange: Exchange;

  @Column()
  externalId: string;

  @Column()
  title: string;

  @Column({ type: 'varchar' })
  category: NoticeCategory;

  @Column({ nullable: true })
  originalCategory: string;

  @Column({ nullable: true })
  url: string;

  @Column({ nullable: true })
  publishedAt: string;

  @Column({ default: false })
  notified: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
