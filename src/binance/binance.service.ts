import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { TelegramService } from '../telegram/telegram.service';
import { ClassifierService } from '../classifier/classifier.service';
import { Notice, Exchange } from '../database/entities/notice.entity';

interface BinanceArticle {
  id: number;
  code: string;
  title: string;
  releaseDate: number;
}

interface BinanceCatalog {
  catalogId: number;
  catalogName: string;
  articles: BinanceArticle[];
}

interface BinanceResponse {
  success: boolean;
  data: { catalogs: BinanceCatalog[] };
}

@Injectable()
export class BinanceService implements OnModuleInit {
  private readonly logger = new Logger(BinanceService.name);
  private readonly API_URL =
    'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query';
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
    bot.command('binancenotice', async () => {
      try {
        const notices = await this.noticeRepository.find({
          where: { exchange: Exchange.BINANCE },
          order: { publishedAt: 'DESC' },
          take: 10,
        });
        if (notices.length === 0) {
          await this.telegramService.sendMessage('바이낸스 공지사항이 아직 없습니다.');
          return;
        }
        const lines = notices.map((n) =>
          this.classifierService.formatNotice(n.exchange, n.category, n.title, n.url),
        );
        await this.telegramService.sendMessage(`📋 <b>바이낸스 최근 공지사항</b>\n\n${lines.join('\n\n')}`);
      } catch (error) {
        await this.telegramService.sendMessage(`❌ 바이낸스 공지 조회 실패: ${error.message}`);
      }
    });
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async monitor() {
    if (this.isMonitoring) return;
    this.isMonitoring = true;
    try {
      const articles = await this.fetchNotices();
      for (const article of articles) {
        const externalId = String(article.id);
        const exists = await this.noticeRepository.findOne({
          where: { exchange: Exchange.BINANCE, externalId },
        });
        if (exists) continue;

        const category = this.classifierService.classify(article.title);
        const url = `https://www.binance.com/en/support/announcement/${article.code}`;
        const notice = this.noticeRepository.create({
          exchange: Exchange.BINANCE,
          externalId,
          title: article.title,
          category,
          url,
          publishedAt: new Date(article.releaseDate).toISOString(),
          notified: false,
        });
        await this.noticeRepository.save(notice);

        if (this.initialized) {
          await this.telegramService.sendMessage(
            this.classifierService.formatNotice(Exchange.BINANCE, category, article.title, url),
          );
          notice.notified = true;
          await this.noticeRepository.save(notice);
        }
      }
      if (!this.initialized) {
        this.initialized = true;
        this.logger.log(`Initial sync complete. ${articles.length} notices loaded.`);
      }
    } catch (error) {
      this.logger.error(`Binance monitor failed: ${error.message}`);
    } finally {
      this.isMonitoring = false;
    }
  }

  async fetchNotices(): Promise<BinanceArticle[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<BinanceResponse>(this.API_URL, {
        params: { type: 1, pageNo: 1, pageSize: 20 },
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'en',
        },
      }),
    );
    const articles: BinanceArticle[] = [];
    for (const catalog of data.data.catalogs) {
      articles.push(...catalog.articles);
    }
    return articles;
  }
}
