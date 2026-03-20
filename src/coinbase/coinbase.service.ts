import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { TelegramService } from '../telegram/telegram.service';
import { ClassifierService } from '../classifier/classifier.service';
import {
  Notice,
  Exchange,
  NoticeCategory,
} from '../database/entities/notice.entity';

interface CoinbaseIncident {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  shortlink: string;
  impact: string;
}

interface CoinbaseIncidentResponse {
  incidents: CoinbaseIncident[];
}

@Injectable()
export class CoinbaseService implements OnModuleInit {
  private readonly logger = new Logger(CoinbaseService.name);
  private readonly INCIDENTS_URL =
    'https://status.coinbase.com/api/v2/incidents.json';
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
    bot.command('coinbasenotice', async () => {
      try {
        const notices = await this.noticeRepository.find({
          where: { exchange: Exchange.COINBASE },
          order: { publishedAt: 'DESC' },
          take: 10,
        });
        if (notices.length === 0) {
          await this.telegramService.sendMessage(
            '코인베이스 공지사항이 아직 없습니다.',
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
          `📋 <b>코인베이스 최근 공지사항</b>\n\n${lines.join('\n\n')}`,
        );
      } catch (error) {
        await this.telegramService.sendMessage(
          `❌ 코인베이스 공지 조회 실패: ${error.message}`,
        );
      }
    });
  }

  @Cron(CronExpression.EVERY_SECOND)
  async monitor() {
    if (this.isMonitoring) return;
    this.isMonitoring = true;
    try {
      const incidents = await this.fetchIncidents();
      for (const incident of incidents) {
        const externalId = incident.id;
        const exists = await this.noticeRepository.findOne({
          where: { exchange: Exchange.COINBASE, externalId },
        });
        if (exists) continue;

        const category =
          incident.impact === 'none'
            ? NoticeCategory.ETC
            : NoticeCategory.DEPOSIT_SUSPEND;
        const notice = this.noticeRepository.create({
          exchange: Exchange.COINBASE,
          externalId,
          title: incident.name,
          category,
          originalCategory: `${incident.status} / ${incident.impact}`,
          url: incident.shortlink,
          publishedAt: incident.created_at,
          notified: false,
        });
        await this.noticeRepository.save(notice);

        if (this.initialized) {
          await this.telegramService.sendMessage(
            this.classifierService.formatNotice(
              Exchange.COINBASE,
              category,
              incident.name,
              incident.shortlink,
            ),
          );
          notice.notified = true;
          await this.noticeRepository.save(notice);
        }
      }
      if (!this.initialized) {
        this.initialized = true;
        this.logger.log(
          `Initial sync complete. ${incidents.length} incidents loaded.`,
        );
      }
    } catch (error) {
      this.logger.error(`Coinbase monitor failed: ${error.message}`);
    } finally {
      this.isMonitoring = false;
    }
  }

  private async fetchIncidents(): Promise<CoinbaseIncident[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<CoinbaseIncidentResponse>(this.INCIDENTS_URL),
    );
    return data.incidents.slice(0, 20);
  }
}
