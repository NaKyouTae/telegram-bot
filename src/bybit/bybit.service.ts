import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { TelegramService } from '../telegram/telegram.service';
import { ClassifierService } from '../classifier/classifier.service';
import { Notice, Exchange } from '../database/entities/notice.entity';

interface BybitAnnouncement {
  title: string;
  description: string;
  type: { title: string; key: string };
  tags: string[];
  url: string;
  dateTimestamp: number;
  publishTime: number;
}

interface BybitResponse {
  retCode: number;
  result: { total: number; list: BybitAnnouncement[] };
}

@Injectable()
export class BybitService implements OnModuleInit {
  private readonly logger = new Logger(BybitService.name);
  private readonly API_URL = 'https://api.bybit.com/v5/announcements/index';
  private initialized = false;
  private isMonitoring = false;

  constructor(
    private httpService: HttpService,
    private telegramService: TelegramService,
    private classifierService: ClassifierService,
    @InjectRepository(Notice)
    private noticeRepository: Repository<Notice>,
  ) {}

  onModuleInit() {
    const bot = this.telegramService.getBot();
    bot.command('bybitnotice', async () => {
      try {
        const notices = await this.noticeRepository.find({
          where: { exchange: Exchange.BYBIT },
          order: { publishedAt: 'DESC' },
          take: 10,
        });
        if (notices.length === 0) {
          await this.telegramService.sendMessage('바이비트 공지사항이 아직 없습니다.');
          return;
        }
        const lines = notices.map((n) =>
          this.classifierService.formatNotice(n.exchange, n.category, n.title, n.url),
        );
        await this.telegramService.sendMessage(`📋 <b>바이비트 최근 공지사항</b>\n\n${lines.join('\n\n')}`);
      } catch (error) {
        await this.telegramService.sendMessage(`❌ 바이비트 공지 조회 실패: ${error.message}`);
      }
    });
  }

  @Cron(CronExpression.EVERY_SECOND)
  async monitor() {
    if (this.isMonitoring) return;
    this.isMonitoring = true;
    try {
      const announcements = await this.fetchNotices();
      for (const ann of announcements) {
        const externalId = `${ann.publishTime}_${ann.title.substring(0, 50)}`;
        const exists = await this.noticeRepository.findOne({
          where: { exchange: Exchange.BYBIT, externalId },
        });
        if (exists) continue;

        const category = this.classifierService.classify(ann.title);
        const notice = this.noticeRepository.create({
          exchange: Exchange.BYBIT,
          externalId,
          title: ann.title,
          category,
          originalCategory: ann.type.key,
          url: ann.url,
          publishedAt: new Date(ann.publishTime).toISOString(),
          notified: false,
        });
        await this.noticeRepository.save(notice);

        if (this.initialized) {
          await this.telegramService.sendMessage(
            this.classifierService.formatNotice(Exchange.BYBIT, category, ann.title, ann.url),
          );
          notice.notified = true;
          await this.noticeRepository.save(notice);
        }
      }
      if (!this.initialized) {
        this.initialized = true;
        this.logger.log(`Initial sync complete. ${announcements.length} notices loaded.`);
      }
    } catch (error) {
      this.logger.error(`Bybit monitor failed: ${error.message}`);
    } finally {
      this.isMonitoring = false;
    }
  }

  async fetchNotices(): Promise<BybitAnnouncement[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<BybitResponse>(this.API_URL, {
        params: { locale: 'en-US', limit: 20 },
      }),
    );
    return data.result?.list || [];
  }
}
