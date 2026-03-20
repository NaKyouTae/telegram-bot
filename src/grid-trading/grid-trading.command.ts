import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { TelegramService } from '../telegram/telegram.service';
import { GridTradingService } from './grid-trading.service';
import { GridUser } from '../database/entities/grid-user.entity';
import { PacificaClientFactory } from './pacifica-client.factory';
import { encrypt } from './crypto.util';

@Injectable()
export class GridTradingCommand implements OnModuleInit {
  private readonly logger = new Logger(GridTradingCommand.name);
  private adminId: number | null = null;

  constructor(
    private telegramService: TelegramService,
    private gridTradingService: GridTradingService,
    private configService: ConfigService,
    private pacificaClientFactory: PacificaClientFactory,
    @InjectRepository(GridUser)
    private gridUserRepository: Repository<GridUser>,
  ) {
    const id = this.configService.get<string>('GRID_ADMIN_ID');
    this.adminId = id ? parseInt(id, 10) : null;
  }

  private isAdmin(userId: number): boolean {
    if (!this.adminId) return false;
    return userId === this.adminId;
  }

  private async isAuthorized(userId: number): Promise<boolean> {
    if (this.isAdmin(userId)) return true;
    const user = await this.gridUserRepository.findOne({
      where: { telegramId: userId },
    });
    return !!user;
  }

  onModuleInit() {
    const bot = this.telegramService.getBot();

    bot.command('grid', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const text = ctx.message.text;
      const args = text.split(' ').slice(1);

      if (args.length === 0) {
        if (!(await this.isAuthorized(userId))) {
          await ctx.reply('🔒 권한이 없습니다.');
          return;
        }
        await ctx.reply(
          '📊 그리드 매매 명령어:\n\n' +
            '/grid setkey <apiKey> <privateKey>\n' +
            '  API 키 등록 (DM으로 입력하세요)\n\n' +
            '/grid balance\n' +
            '  잔고 조회\n\n' +
            '/grid start <종목> <하한가> <상한가> <그리드수> <투자금> [레버리지]\n' +
            '  예: /grid start BTC 90000 100000 10 1000 3\n' +
            '  레버리지 미입력 시 1x (기본값)\n\n' +
            '/grid stop\n' +
            '  그리드 매매 중지 및 모든 주문 취소\n\n' +
            '/grid status\n' +
            '  현재 그리드 매매 상태 조회\n\n' +
            '/grid price <종목>\n' +
            '  현재가 조회 (예: /grid price SOL)\n\n' +
            '👑 관리자 명령어:\n' +
            '/grid invite <유저ID> - 유저 추가\n' +
            '/grid kick <유저ID> - 유저 제거\n' +
            '/grid users - 허용된 유저 목록',
        );
        return;
      }

      const subCommand = args[0].toLowerCase();

      // 관리자 전용 명령어
      if (['invite', 'kick', 'users'].includes(subCommand)) {
        if (!this.isAdmin(userId)) {
          await ctx.reply('🔒 관리자만 사용할 수 있는 명령어입니다.');
          return;
        }

        switch (subCommand) {
          case 'invite':
            await this.handleInvite(ctx, args.slice(1));
            break;
          case 'kick':
            await this.handleKick(ctx, args.slice(1));
            break;
          case 'users':
            await this.handleUsers(ctx);
            break;
        }
        return;
      }

      // setkey는 권한 확인 후 처리
      if (subCommand === 'setkey') {
        if (!(await this.isAuthorized(userId))) {
          await ctx.reply('🔒 권한이 없습니다.');
          return;
        }
        await this.handleSetKey(ctx, userId, args.slice(1));
        return;
      }

      // 일반 명령어 — 권한 확인
      if (!(await this.isAuthorized(userId))) {
        await ctx.reply('🔒 권한이 없습니다.');
        return;
      }

      switch (subCommand) {
        case 'price':
          await this.handlePrice(ctx, args.slice(1));
          break;
        case 'balance':
          await this.handleBalance(ctx, userId);
          break;
        case 'start':
          await this.handleStart(ctx, userId, args.slice(1));
          break;
        case 'stop':
          await this.handleStop(ctx, userId);
          break;
        case 'status':
          await this.handleStatus(ctx, userId);
          break;
        default:
          await ctx.reply(
            '❌ 알 수 없는 명령어입니다. /grid 를 입력해 사용법을 확인하세요.',
          );
      }
    });

    this.logger.log('Grid trading commands registered');
  }

  private async handleSetKey(
    ctx: any,
    userId: number,
    args: string[],
  ): Promise<void> {
    if (args.length < 2) {
      await ctx.reply(
        '❌ 사용법: /grid setkey <apiKey> <privateKey>\n\n' +
          '⚠️ 보안을 위해 봇과의 DM에서 입력하세요.',
      );
      return;
    }

    const [apiKey, privateKey] = args;

    // 키 유효성 검증
    try {
      const decoded = bs58.decode(privateKey);
      Keypair.fromSecretKey(decoded);
    } catch {
      await ctx.reply('❌ 유효하지 않은 Private Key입니다. Base58 형식의 Solana 키를 입력하세요.');
      return;
    }

    try {
      // 원본 메시지 삭제 (키 노출 방지)
      await ctx.deleteMessage().catch(() => {});

      const encryptionKey = this.configService.getOrThrow<string>(
        'GRID_ENCRYPTION_KEY',
      );

      const encryptedApiKey = encrypt(apiKey, encryptionKey);
      const encryptedPrivateKey = encrypt(privateKey, encryptionKey);

      await this.gridUserRepository.update(
        { telegramId: userId },
        { encryptedApiKey, encryptedPrivateKey },
      );

      // 캐시된 클라이언트 제거 (새 키로 재생성되도록)
      this.pacificaClientFactory.removeClient(userId);

      await ctx.reply('✅ API 키가 등록되었습니다. 이제 그리드 매매를 사용할 수 있습니다.');
      this.logger.log(`User ${userId} set API keys`);
    } catch (error) {
      this.logger.error(`SetKey failed for user ${userId}: ${error.message}`);
      await ctx.reply('❌ 키 등록 실패. 다시 시도해주세요.');
    }
  }

  private async handleInvite(ctx: any, args: string[]): Promise<void> {
    if (args.length < 1) {
      await ctx.reply('❌ 사용법: /grid invite <텔레그램 유저 ID>');
      return;
    }

    const telegramId = parseInt(args[0], 10);
    if (isNaN(telegramId)) {
      await ctx.reply('❌ 유저 ID는 숫자여야 합니다.');
      return;
    }

    const existing = await this.gridUserRepository.findOne({
      where: { telegramId },
    });
    if (existing) {
      await ctx.reply('⚠️ 이미 등록된 유저입니다.');
      return;
    }

    const user = this.gridUserRepository.create({
      telegramId,
      username: args[1] ?? null,
    });
    await this.gridUserRepository.save(user);

    await ctx.reply(`✅ 유저 추가 완료\nID: ${telegramId}\n\n유저가 /grid setkey 로 API 키를 등록해야 매매가 가능합니다.`);
    this.logger.log(`User invited: ${telegramId}`);
  }

  private async handleKick(ctx: any, args: string[]): Promise<void> {
    if (args.length < 1) {
      await ctx.reply('❌ 사용법: /grid kick <텔레그램 유저 ID>');
      return;
    }

    const telegramId = parseInt(args[0], 10);
    if (isNaN(telegramId)) {
      await ctx.reply('❌ 유저 ID는 숫자여야 합니다.');
      return;
    }

    const result = await this.gridUserRepository.delete({ telegramId });
    if (result.affected === 0) {
      await ctx.reply('⚠️ 등록되지 않은 유저입니다.');
      return;
    }

    this.pacificaClientFactory.removeClient(telegramId);
    await ctx.reply(`✅ 유저 제거 완료\nID: ${telegramId}`);
    this.logger.log(`User kicked: ${telegramId}`);
  }

  private async handleUsers(ctx: any): Promise<void> {
    const users = await this.gridUserRepository.find({
      order: { createdAt: 'ASC' },
    });

    if (users.length === 0) {
      await ctx.reply('📋 등록된 유저가 없습니다.\n\n/grid invite <ID>로 추가하세요.');
      return;
    }

    const list = users
      .map(
        (u, i) => {
          const keyStatus = u.encryptedPrivateKey ? '🔑' : '⚠️ 키 미등록';
          return `${i + 1}. ${u.telegramId}${u.username ? ` (@${u.username})` : ''} ${keyStatus}`;
        },
      )
      .join('\n');

    await ctx.reply(
      `📋 허용된 유저 목록 (${users.length}명)\n\n${list}`,
    );
  }

  private async handlePrice(ctx: any, args: string[]): Promise<void> {
    if (args.length < 1) {
      await ctx.reply('❌ 사용법: /grid price <종목>\n예: /grid price SOL');
      return;
    }

    const symbol = args[0].toUpperCase();

    try {
      const price = await this.gridTradingService.getPrice(symbol);
      await ctx.reply(
        `💰 <b>${symbol} 현재가</b>\n\n$${price.toLocaleString()}`,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      await ctx.reply(`❌ 가격 조회 실패: ${error.message}`);
    }
  }

  private async handleBalance(ctx: any, userId: number): Promise<void> {
    const result = await this.gridTradingService.getBalance(userId);
    await ctx.reply(result, { parse_mode: 'HTML' });
  }

  private async handleStart(
    ctx: any,
    userId: number,
    args: string[],
  ): Promise<void> {
    if (args.length === 0) {
      await ctx.reply(
        '❌ 종목을 입력해주세요.\n\n' +
          '사용법: /grid start <종목> <하한가> <상한가> <그리드수> <투자금> [레버리지]\n\n' +
          '예시:\n' +
          '/grid start SOL 85 91 5 5 1\n' +
          '/grid start BTC 82000 86000 10 10 1\n' +
          '/grid start ETH 2000 2200 10 10 3',
      );
      return;
    }

    if (args.length < 5) {
      await ctx.reply(
        '❌ 파라미터가 부족합니다.\n\n' +
          '사용법: /grid start <종목> <하한가> <상한가> <그리드수> <투자금> [레버리지]\n\n' +
          '예시: /grid start SOL 85 91 5 5 1',
      );
      return;
    }

    const [symbol, lowerStr, upperStr, countStr, amountStr, leverageStr] =
      args;
    const lowerPrice = parseFloat(lowerStr);
    const upperPrice = parseFloat(upperStr);
    const gridCount = parseInt(countStr, 10);
    const totalAmount = parseFloat(amountStr);
    const leverage = leverageStr ? parseInt(leverageStr, 10) : 1;

    if (
      isNaN(lowerPrice) ||
      isNaN(upperPrice) ||
      isNaN(gridCount) ||
      isNaN(totalAmount) ||
      isNaN(leverage)
    ) {
      await ctx.reply('❌ 숫자 형식이 올바르지 않습니다.');
      return;
    }

    if (totalAmount <= 0) {
      await ctx.reply('❌ 투자금은 0보다 커야 합니다.');
      return;
    }

    const result = await this.gridTradingService.start(
      userId,
      symbol.toUpperCase(),
      lowerPrice,
      upperPrice,
      gridCount,
      totalAmount,
      leverage,
    );

    await ctx.reply(result, { parse_mode: 'HTML' });
  }

  private async handleStop(ctx: any, userId: number): Promise<void> {
    const result = await this.gridTradingService.stop(userId);
    await ctx.reply(result, { parse_mode: 'HTML' });
  }

  private async handleStatus(ctx: any, userId: number): Promise<void> {
    const result = await this.gridTradingService.getStatus(userId);
    await ctx.reply(result, { parse_mode: 'HTML' });
  }
}
