import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { TelegramService } from '../telegram/telegram.service';
import { ClassifierService } from '../classifier/classifier.service';
import { Notice, Exchange } from '../database/entities/notice.entity';

interface CoinoneNoticeRaw {
  id: number;
  title: string;
  notice_type: string;
  notice_type_num: number;
  created_at: string;
  updated_at: string;
}

interface CoinoneResponse {
  count: number;
  result: CoinoneNoticeRaw[];
}

@Injectable()
export class CoinoneService implements OnModuleInit {
  private readonly logger = new Logger(CoinoneService.name);
  private readonly API_URL = 'https://coinone.co.kr/api/talk/notice/';
  private initialized = false;

  constructor(
    private httpService: HttpService,
    private telegramService: TelegramService,
    private classifierService: ClassifierService,
    @InjectRepository(Notice)
    private noticeRepository: Repository<Notice>,
  ) {}

  onModuleInit() {
    const bot = this.telegramService.getBot();
    bot.command('coinonenotice', async () => {
      try {
        const notices = await this.noticeRepository.find({
          where: { exchange: Exchange.COINONE },
          order: { publishedAt: 'DESC' },
          take: 10,
        });
        if (notices.length === 0) {
          await this.telegramService.sendMessage('코인원 공지사항이 아직 없습니다.');
          return;
        }
        const lines = notices.map((n) =>
          this.classifierService.formatNotice(n.exchange, n.category, n.title, n.url),
        );
        await this.telegramService.sendMessage(`📋 <b>코인원 최근 공지사항</b>\n\n${lines.join('\n\n')}`);
      } catch (error) {
        await this.telegramService.sendMessage(`❌ 코인원 공지 조회 실패: ${error.message}`);
      }
    });
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async monitor() {
    try {
      const rawNotices = await this.fetchNotices();
      for (const raw of rawNotices) {
        const externalId = String(raw.id);
        const exists = await this.noticeRepository.findOne({
          where: { exchange: Exchange.COINONE, externalId },
        });
        if (exists) continue;

        const category = this.classifierService.classify(raw.title);
        const url = `https://coinone.co.kr/talk/notice/detail/${raw.id}`;
        const notice = this.noticeRepository.create({
          exchange: Exchange.COINONE,
          externalId,
          title: raw.title,
          category,
          originalCategory: raw.notice_type,
          url,
          publishedAt: raw.created_at,
          notified: false,
        });
        await this.noticeRepository.save(notice);

        if (this.initialized) {
          await this.telegramService.sendMessage(
            this.classifierService.formatNotice(Exchange.COINONE, category, raw.title, url),
          );
          notice.notified = true;
          await this.noticeRepository.save(notice);
        }
      }
      if (!this.initialized) {
        this.initialized = true;
        this.logger.log(`Initial sync complete. ${rawNotices.length} notices loaded.`);
      }
    } catch (error) {
      this.logger.error(`Coinone monitor failed: ${error.message}`);
    }
  }

  async fetchNotices(): Promise<CoinoneNoticeRaw[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<CoinoneResponse>(this.API_URL, {
        params: { page: 1 },
      }),
    );
    return data.result;
  }
}
