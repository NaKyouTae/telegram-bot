import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { TelegramService } from '../telegram/telegram.service';
import { ClassifierService } from '../classifier/classifier.service';
import { Notice, Exchange } from '../database/entities/notice.entity';

export interface UpbitNoticeRaw {
  id: number;
  title: string;
  category: string;
  listed_at: string;
  first_listed_at: string;
  need_new_badge: boolean;
  need_update_badge: boolean;
}

interface UpbitNoticeResponse {
  success: boolean;
  data: {
    total_pages: number;
    total_count: number;
    notices: UpbitNoticeRaw[];
  };
}

@Injectable()
export class UpbitService implements OnModuleInit {
  private readonly logger = new Logger(UpbitService.name);
  private readonly API_URL =
    'https://api-manager.upbit.com/api/v1/announcements';
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

    bot.command('upbitnotice', async () => {
      try {
        const notices = await this.noticeRepository.find({
          where: { exchange: Exchange.UPBIT },
          order: { publishedAt: 'DESC' },
          take: 10,
        });
        if (notices.length === 0) {
          await this.telegramService.sendMessage(
            '업비트 공지사항이 아직 없습니다.',
          );
          return;
        }
        const lines = notices.map((n) =>
          this.classifierService.formatNotice(
            n.exchange,
            n.category,
            n.title,
            n.url,
          ),
        );
        await this.telegramService.sendMessage(
          `📋 <b>업비트 최근 공지사항</b>\n\n${lines.join('\n\n')}`,
        );
      } catch (error) {
        await this.telegramService.sendMessage(
          `❌ 업비트 공지 조회 실패: ${error.message}`,
        );
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
          where: { exchange: Exchange.UPBIT, externalId },
        });
        if (exists) continue;

        const category = this.classifierService.classify(raw.title);
        const url = `https://upbit.com/service_center/notice?id=${raw.id}`;
        const notice = this.noticeRepository.create({
          exchange: Exchange.UPBIT,
          externalId,
          title: raw.title,
          category,
          originalCategory: raw.category,
          url,
          publishedAt: raw.listed_at,
          notified: false,
        });
        await this.noticeRepository.save(notice);

        if (this.initialized) {
          const message = this.classifierService.formatNotice(
            Exchange.UPBIT,
            category,
            raw.title,
            url,
          );
          await this.telegramService.sendMessage(message);
          notice.notified = true;
          await this.noticeRepository.save(notice);
        }
      }

      if (!this.initialized) {
        this.initialized = true;
        this.logger.log(
          `Initial sync complete. ${rawNotices.length} notices loaded.`,
        );
      }
    } catch (error) {
      this.logger.error(`Upbit monitor failed: ${error.message}`);
    }
  }

  async fetchNotices(): Promise<UpbitNoticeRaw[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<UpbitNoticeResponse>(this.API_URL, {
        params: { os: 'web', category: 'all', page: 1, per_page: 20 },
        headers: { accept: 'application/json' },
      }),
    );
    return data.data.notices;
  }
}
