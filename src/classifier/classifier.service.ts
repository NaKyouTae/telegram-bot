import { Injectable } from '@nestjs/common';
import { NoticeCategory } from '../database/entities/notice.entity';

interface ClassifyRule {
  category: NoticeCategory;
  keywords: string[];
}

@Injectable()
export class ClassifierService {
  private readonly rules: ClassifyRule[] = [
    // 순서 중요: 먼저 매칭되는 규칙이 우선
    {
      category: NoticeCategory.DELIST,
      keywords: [
        '거래 지원 종료',
        '상장폐지',
        '마켓 유의종목 해제 및 거래지원종료',
        'delisting',
        'delist',
        'remove',
      ],
    },
    {
      category: NoticeCategory.DELIST_WARNING_RELEASE,
      keywords: ['유의종목 해제', '거래유의 해제', '투자유의 해제'],
    },
    {
      category: NoticeCategory.DELIST_WARNING,
      keywords: [
        '거래유의종목 지정',
        '거래유의종목지정',
        '투자유의',
        '유의종목 지정',
        '거래유의',
      ],
    },
    {
      category: NoticeCategory.LISTING,
      keywords: [
        '신규 상장',
        '신규상장',
        '디지털 자산 추가',
        'new listing',
        'new cryptocurrency listing',
        'will list',
        'now launched',
      ],
    },
    {
      category: NoticeCategory.MARKET_ADD,
      keywords: [
        '원화 마켓 추가',
        '마켓 추가',
        'KRW 마켓',
        'BTC 마켓',
        '거래 페어 추가',
      ],
    },
    {
      category: NoticeCategory.DEPOSIT_RESUME,
      keywords: [
        '입출금 재개',
        '입출금 정상화',
        '입금 재개',
        '출금 재개',
        '완료',
        'resumption',
        'resume',
      ],
    },
    {
      category: NoticeCategory.DEPOSIT_SUSPEND,
      keywords: [
        '입출금 중단',
        '입출금 일시 중단',
        '입출금 중지',
        '입출금 일시 중지',
        '입출금 일시중단',
        '출금 중단',
        '입금 중단',
        '출금 일시',
        '입금 일시',
        'suspend',
        'suspension',
        'maintenance',
      ],
    },
    {
      category: NoticeCategory.NETWORK,
      keywords: [
        '네트워크 전환',
        '네트워크 업그레이드',
        '메인넷 스왑',
        '메인넷 전환',
        '하드포크',
      ],
    },
    {
      category: NoticeCategory.AIRDROP,
      keywords: ['에어드랍', '에어드롭', 'airdrop', 'air drop'],
    },
    {
      category: NoticeCategory.STAKING,
      keywords: ['스테이킹', '락업', '스테이크', 'staking', 'lockup', 'earn'],
    },
    {
      category: NoticeCategory.EVENT,
      keywords: [
        '이벤트',
        '프로모션',
        '캠페인',
        '경품',
        '리워드',
        'event',
        'promotion',
        'campaign',
        'reward',
      ],
    },
  ];

  classify(title: string): NoticeCategory {
    const lowerTitle = title.toLowerCase();
    for (const rule of this.rules) {
      for (const keyword of rule.keywords) {
        if (lowerTitle.includes(keyword.toLowerCase())) {
          return rule.category;
        }
      }
    }
    return NoticeCategory.ETC;
  }

  getCategoryEmoji(category: NoticeCategory): string {
    const emojiMap: Record<NoticeCategory, string> = {
      [NoticeCategory.LISTING]: '🟢',
      [NoticeCategory.MARKET_ADD]: '🟢',
      [NoticeCategory.DELIST_WARNING]: '🔴',
      [NoticeCategory.DELIST_WARNING_RELEASE]: '🟡',
      [NoticeCategory.DELIST]: '🔴',
      [NoticeCategory.DEPOSIT_SUSPEND]: '🟡',
      [NoticeCategory.DEPOSIT_RESUME]: '🟢',
      [NoticeCategory.NETWORK]: '🟡',
      [NoticeCategory.AIRDROP]: '🎁',
      [NoticeCategory.EVENT]: '🎉',
      [NoticeCategory.STAKING]: '💎',
      [NoticeCategory.ETC]: '📢',
    };
    return emojiMap[category];
  }

  getCategoryLabel(category: NoticeCategory): string {
    const labelMap: Record<NoticeCategory, string> = {
      [NoticeCategory.LISTING]: '신규 상장',
      [NoticeCategory.MARKET_ADD]: '마켓 추가',
      [NoticeCategory.DELIST_WARNING]: '거래유의',
      [NoticeCategory.DELIST_WARNING_RELEASE]: '유의종목 해제',
      [NoticeCategory.DELIST]: '상장폐지',
      [NoticeCategory.DEPOSIT_SUSPEND]: '입출금 중단',
      [NoticeCategory.DEPOSIT_RESUME]: '입출금 재개',
      [NoticeCategory.NETWORK]: '네트워크',
      [NoticeCategory.AIRDROP]: '에어드랍',
      [NoticeCategory.EVENT]: '이벤트',
      [NoticeCategory.STAKING]: '스테이킹',
      [NoticeCategory.ETC]: '기타',
    };
    return labelMap[category];
  }

  formatNotice(
    exchange: string,
    category: NoticeCategory,
    title: string,
    url: string,
  ): string {
    const emoji = this.getCategoryEmoji(category);
    const label = this.getCategoryLabel(category);
    const exchangeLabels: Record<string, string> = {
      upbit: '업비트',
      bithumb: '빗썸',
      binance: '바이낸스',
      okx: 'OKX',
      coinone: '코인원',
      bitget: '비트겟',
      bybit: '바이비트',
      coinbase: '코인베이스',
    };
    const exchangeLabel = exchangeLabels[exchange] || exchange;
    return (
      `${emoji} <b>#${label}</b> [${exchangeLabel}]\n` +
      `${title}\n` +
      `${url}`
    );
  }
}
