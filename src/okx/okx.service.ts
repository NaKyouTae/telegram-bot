import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { TelegramService } from '../telegram/telegram.service';
import { ClassifierService } from '../classifier/classifier.service';
import { Notice, Exchange } from '../database/entities/notice.entity';

interface OkxAnnouncement {
  annType: string;
  title: string;
  url: string;
  pTime: string;
}

interface OkxResponse {
  code: string;
  data: [{ totalPage: string; details: OkxAnnouncement[] }];
}

@Injectable()
export class OkxService implements OnModuleInit {
  private readonly logger = new Logger(OkxService.name);
  private readonly API_URL = 'https://www.okx.com/api/v5/support/announcements';
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
    bot.command('okxnotice', async () => {
      try {
        const notices = await this.noticeRepository.find({
          where: { exchange: Exchange.OKX },
          order: { publishedAt: 'DESC' },
          take: 10,
        });
        if (notices.length === 0) {
          await this.telegramService.sendMessage('OKX 공지사항이 아직 없습니다.');
          return;
        }
        const lines = notices.map((n) =>
          this.classifierService.formatNotice(n.exchange, n.category, n.title, n.url),
        );
        await this.telegramService.sendMessage(`📋 <b>OKX 최근 공지사항</b>\n\n${lines.join('\n\n')}`);
      } catch (error) {
        await this.telegramService.sendMessage(`❌ OKX 공지 조회 실패: ${error.message}`);
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
        const externalId = `${ann.pTime}_${ann.title.substring(0, 50)}`;
        const exists = await this.noticeRepository.findOne({
          where: { exchange: Exchange.OKX, externalId },
        });
        if (exists) continue;

        const category = this.classifierService.classify(ann.title);
        const notice = this.noticeRepository.create({
          exchange: Exchange.OKX,
          externalId,
          title: ann.title,
          category,
          originalCategory: ann.annType,
          url: ann.url,
          publishedAt: new Date(Number(ann.pTime)).toISOString(),
          notified: false,
        });
        await this.noticeRepository.save(notice);

        if (this.initialized) {
          await this.telegramService.sendMessage(
            this.classifierService.formatNotice(Exchange.OKX, category, ann.title, ann.url),
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
      this.logger.error(`OKX monitor failed: ${error.message}`);
    } finally {
      this.isMonitoring = false;
    }
  }

  async fetchNotices(): Promise<OkxAnnouncement[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<OkxResponse>(this.API_URL, {
        params: { page: 1, limit: 20 },
      }),
    );
    return data.data[0]?.details || [];
  }
}
