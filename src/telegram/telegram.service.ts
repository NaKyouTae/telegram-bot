import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context } from 'telegraf';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;
  private channelId: string | null = null;

  constructor(private configService: ConfigService) {
    const token = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.bot = new Telegraf(token);
    this.channelId =
      this.configService.get<string>('TELEGRAM_CHAT_ID') ?? null;
  }

  async onModuleInit() {
    this.bot.command('test', async () => {
      try {
        await this.sendMessage(
          `✅ <b>채널 연동 테스트</b>\n\n` +
            `채널: ${this.channelId}\n` +
            `시간: ${new Date().toLocaleString('ko-KR')}\n\n` +
            `🟢 #신규 상장 [업비트]\n` +
            `테스트코인(TEST) 원화 마켓 추가\n` +
            `https://upbit.com/service_center/notice\n\n` +
            `🔴 #거래유의 [빗썸]\n` +
            `테스트코인(TEST) 거래유의종목 지정\n` +
            `https://feed.bithumb.com/notice`,
        );
      } catch (error) {
        this.logger.error(`Test message failed: ${error.message}`);
      }
    });

    this.bot.command('start', (ctx: Context) => {
      ctx.reply(
        `봇이 활성화되었습니다.\n\n` +
          '📋 공지사항 조회 명령어:\n' +
          '/upbitnotice - 업비트\n' +
          '/bithumbnotice - 빗썸\n' +
          '/binancenotice - 바이낸스\n' +
          '/okxnotice - OKX\n' +
          '/coinonenotice - 코인원\n' +
          '/bitgetnotice - 비트겟\n' +
          '/bybitnotice - 바이비트\n' +
          '/coinbasenotice - 코인베이스\n\n' +
          '🔔 실시간 알림:\n' +
          '8개 거래소의 신규 공지가 올라오면 자동으로 알림을 보내드립니다.',
      );
    });

    this.bot.launch();
    this.logger.log('Telegram bot launched');
    if (this.channelId) {
      this.logger.log(`Channel target: ${this.channelId}`);
    }
  }

  getBot(): Telegraf {
    return this.bot;
  }

  async sendMessage(text: string) {
    if (!this.channelId) {
      this.logger.warn('No TELEGRAM_CHAT_ID set in .env');
      return;
    }
    await this.bot.telegram.sendMessage(this.channelId, text, {
      parse_mode: 'HTML',
    });
  }
}
