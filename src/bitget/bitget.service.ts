import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { TelegramService } from '../telegram/telegram.service';
import { ClassifierService } from '../classifier/classifier.service';
import { Notice, Exchange } from '../database/entities/notice.entity';

interface BitgetAnnouncement {
  annId: string;
  annTitle: string;
  annType: string;
  annUrl: string;
  cTime: string;
}

interface BitgetResponse {
  code: string;
  data: BitgetAnnouncement[];
}

@Injectable()
export class BitgetService implements OnModuleInit {
  private readonly logger = new Logger(BitgetService.name);
  private readonly API_URL =
    'https://api.bitget.com/api/v2/public/annoucements';
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
    bot.command('bitgetnotice', async () => {
      try {
        const notices = await this.noticeRepository.find({
          where: { exchange: Exchange.BITGET },
          order: { publishedAt: 'DESC' },
          take: 10,
        });
        if (notices.length === 0) {
          await this.telegramService.sendMessage('비트겟 공지사항이 아직 없습니다.');
          return;
        }
        const lines = notices.map((n) =>
          this.classifierService.formatNotice(n.exchange, n.category, n.title, n.url),
        );
        await this.telegramService.sendMessage(`📋 <b>비트겟 최근 공지사항</b>\n\n${lines.join('\n\n')}`);
      } catch (error) {
        await this.telegramService.sendMessage(`❌ 비트겟 공지 조회 실패: ${error.message}`);
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
        const externalId = ann.annId;
        const exists = await this.noticeRepository.findOne({
          where: { exchange: Exchange.BITGET, externalId },
        });
        if (exists) continue;

        const category = this.classifierService.classify(ann.annTitle);
        const notice = this.noticeRepository.create({
          exchange: Exchange.BITGET,
          externalId,
          title: ann.annTitle,
          category,
          originalCategory: ann.annType,
          url: ann.annUrl,
          publishedAt: new Date(Number(ann.cTime)).toISOString(),
          notified: false,
        });
        await this.noticeRepository.save(notice);

        if (this.initialized) {
          await this.telegramService.sendMessage(
            this.classifierService.formatNotice(Exchange.BITGET, category, ann.annTitle, ann.annUrl),
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
      this.logger.error(`Bitget monitor failed: ${error.message}`);
    } finally {
      this.isMonitoring = false;
    }
  }

  async fetchNotices(): Promise<BitgetAnnouncement[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<BitgetResponse>(this.API_URL, {
        params: { language: 'en_US' },
      }),
    );
    return data.data || [];
  }
}
