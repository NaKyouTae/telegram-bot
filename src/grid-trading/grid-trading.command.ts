import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Markup } from 'telegraf';
import { TelegramService } from '../telegram/telegram.service';
import { GridTradingService } from './grid-trading.service';
import { GridUser } from '../database/entities/grid-user.entity';
import { PacificaClientFactory } from './pacifica-client.factory';
import { encrypt } from './crypto.util';

interface StartWizardState {
  step: 'symbol' | 'lowerPrice' | 'upperPrice' | 'gridCount' | 'totalAmount' | 'leverage';
  symbol?: string;
  currentPrice?: number;
  balance?: string;
  balanceNum?: number;
  minOrderSize?: number;
  lowerPrice?: number;
  upperPrice?: number;
  gridCount?: number;
  totalAmount?: number;
}

interface SetKeyWizardState {
  step: 'apiKey' | 'privateKey';
  apiKey?: string;
}

@Injectable()
export class GridTradingCommand implements OnModuleInit {
  private readonly logger = new Logger(GridTradingCommand.name);
  private adminId: number | null = null;
  private wizardStates = new Map<number, StartWizardState>();

  private balanceHeader(state: StartWizardState): string {
    return `💳 잔고: $${state.balance ?? '?'}\n\n`;
  }
  private setKeyStates = new Map<number, SetKeyWizardState>();

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
      where: { telegramId: userId, status: 'approved' },
    });
    return !!user;
  }

  onModuleInit() {
    const bot = this.telegramService.getBot();

    // 도움말
    bot.command('help', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!(await this.isAuthorized(userId))) {
        await ctx.reply(
          '🔒 권한이 없습니다.\n\n' +
            '/join 으로 가입 요청을 보내세요.',
        );
        return;
      }

      await ctx.reply(
        '📊 <b>명령어 목록</b>\n\n' +
          '📌 일반\n' +
          '/join - 가입 요청\n' +
          '/setkey - API 키 등록\n' +
          '/balance - 잔고 조회\n' +
          '/price - 현재가 조회\n\n' +
          '📈 매매\n' +
          '/trade - 그리드 매매 시작\n' +
          '/stoptrade - 그리드 매매 중지\n' +
          '/status - 매매 상태 조회',
        { parse_mode: 'HTML' },
      );
    });

    // 가입 요청 — 누구나 사용 가능
    bot.command('join', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      await this.handleJoin(ctx, userId);
    });

    // API 키 등록 (가이드 방식)
    bot.command('setkey', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      if (!(await this.isAuthorized(userId))) {
        await ctx.reply('🔒 권한이 없습니다.');
        return;
      }
      this.setKeyStates.set(userId, { step: 'apiKey' });
      await ctx.reply(
        '🔑 <b>API 키 등록</b>\n\n' +
          '⚠️ 보안을 위해 봇과의 <b>DM</b>에서 진행하세요.\n\n' +
          '1️⃣ Pacifica 거래소에서 API Key 발급\n' +
          '2️⃣ 아래 단계에 따라 키 입력\n\n' +
          '📌 <b>API Key</b>를 입력하세요:',
        { parse_mode: 'HTML' },
      );
    });

    // 잔고 조회
    bot.command('balance', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      if (!(await this.isAuthorized(userId))) {
        await ctx.reply('🔒 권한이 없습니다.');
        return;
      }
      await this.handleBalance(ctx, userId);
    });

    // 현재가 조회 (버튼 선택)
    bot.command('price', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      if (!(await this.isAuthorized(userId))) {
        await ctx.reply('🔒 권한이 없습니다.');
        return;
      }
      await ctx.reply('💰 <b>현재가 조회</b>\n\n종목을 선택하세요:', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          Markup.button.callback('BTC', 'price_sym:BTC'),
          Markup.button.callback('ETH', 'price_sym:ETH'),
          Markup.button.callback('SOL', 'price_sym:SOL'),
        ]),
      });
    });

    // 현재가 조회 버튼 콜백
    bot.action(/^price_sym:(.+)$/, async (ctx) => {
      const symbol = ctx.match[1];
      await ctx.answerCbQuery();
      try {
        const price = await this.gridTradingService.getPrice(symbol);
        await ctx.editMessageText(
          `💰 <b>${symbol} 현재가</b>\n\n$${price.toLocaleString()}`,
          { parse_mode: 'HTML' },
        );
      } catch (error) {
        await ctx.editMessageText(`❌ 가격 조회 실패: ${error.message}`);
      }
    });

    // 그리드 매매 시작 (위자드)
    bot.command('trade', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      if (!(await this.isAuthorized(userId))) {
        await ctx.reply('🔒 권한이 없습니다.');
        return;
      }
      await this.handleStart(ctx, userId);
    });

    // 그리드 매매 중지
    bot.command('stoptrade', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      if (!(await this.isAuthorized(userId))) {
        await ctx.reply('🔒 권한이 없습니다.');
        return;
      }
      await this.handleStop(ctx, userId);
    });

    // 매매 상태 조회
    bot.command('status', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      if (!(await this.isAuthorized(userId))) {
        await ctx.reply('🔒 권한이 없습니다.');
        return;
      }
      await this.handleStatus(ctx, userId);
    });

    // 관리자: 유저 제거
    bot.command('kick', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || !this.isAdmin(userId)) {
        await ctx.reply('🔒 관리자만 사용할 수 있는 명령어입니다.');
        return;
      }
      const args = ctx.message.text.split(' ').slice(1);
      await this.handleKick(ctx, args);
    });

    // 관리자: 유저 목록
    bot.command('users', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || !this.isAdmin(userId)) {
        await ctx.reply('🔒 관리자만 사용할 수 있는 명령어입니다.');
        return;
      }
      await this.handleUsers(ctx);
    });

    // 위자드: 종목 선택
    bot.action(/^grid_sym:(.+)$/, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = this.wizardStates.get(userId);
      if (!state || state.step !== 'symbol') {
        await ctx.answerCbQuery('⚠️ 세션이 만료되었습니다. /trade로 다시 시작하세요.');
        return;
      }

      const symbol = ctx.match[1];
      state.symbol = symbol;
      state.step = 'lowerPrice';

      let priceStr = '';
      try {
        const [price, minOrderSize] = await Promise.all([
          this.gridTradingService.getPrice(symbol),
          this.gridTradingService.getMinOrderSize(symbol),
        ]);
        state.currentPrice = price;
        state.minOrderSize = minOrderSize;
        priceStr = `\n현재가: $${price.toLocaleString()}`;
      } catch {
        // 조회 실패 시 생략
      }

      await ctx.editMessageText(
        `${this.balanceHeader(state)}✅ 종목: <b>${symbol}</b>${priceStr}\n\n📉 <b>하한가</b>를 입력하세요 (USD):`,
        { parse_mode: 'HTML' },
      );
      await ctx.answerCbQuery();
    });

    // 위자드: 그리드 수 선택
    bot.action(/^grid_count:(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = this.wizardStates.get(userId);
      if (!state || state.step !== 'gridCount') {
        await ctx.answerCbQuery('⚠️ 세션이 만료되었습니다.');
        return;
      }

      const count = parseInt(ctx.match[1], 10);
      state.gridCount = count;
      state.step = 'totalAmount';

      await ctx.editMessageText(
        `${this.balanceHeader(state)}✅ 그리드 수: ${count}개\n\n💰 <b>총 투자금</b>을 입력하세요 (USD):`,
        { parse_mode: 'HTML' },
      );
      await ctx.answerCbQuery();
    });

    // 위자드: 레버리지 선택 → 미리보기
    bot.action(/^grid_lev:(\d+)$/, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const state = this.wizardStates.get(userId);
      if (!state || state.step !== 'leverage') {
        await ctx.answerCbQuery('⚠️ 세션이 만료되었습니다.');
        return;
      }

      const leverage = parseInt(ctx.match[1], 10);

      await ctx.editMessageText(`${this.balanceHeader(state)}✅ 레버리지: ${leverage}x\n\n⏳ 매매 계획을 불러오는 중...`, { parse_mode: 'HTML' });
      await ctx.answerCbQuery();

      await this.showPreview(ctx, userId, leverage);
    });

    // 위자드 취소
    bot.action('grid_wizard_cancel', async (ctx) => {
      const userId = ctx.from?.id;
      if (userId) this.wizardStates.delete(userId);
      await ctx.editMessageText('↩️ 그리드 매매 설정이 취소되었습니다.');
      await ctx.answerCbQuery('취소됨');
    });

    // 텍스트 입력 처리 (위자드 진행 중인 유저)
    bot.on('text', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const text = ctx.message.text;
      if (text.startsWith('/')) return;

      // setkey 위자드
      const keyState = this.setKeyStates.get(userId);
      if (keyState) {
        await this.handleSetKeyInput(ctx, userId, text.trim());
        return;
      }

      // trade 위자드
      const state = this.wizardStates.get(userId);
      if (!state) return;

      await this.handleWizardInput(ctx, userId, text.trim());
    });

    // 그리드 시작 확인 버튼
    bot.action(/^grid_confirm:(.+)$/, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const parts = ctx.match[1].split(':');
      const [symbol, lower, upper, count, amount, lev] = parts;

      await ctx.editMessageText('⏳ 그리드 매매를 시작하는 중...', { parse_mode: 'HTML' });
      await ctx.answerCbQuery();

      const result = await this.gridTradingService.start(
        userId,
        symbol,
        parseFloat(lower),
        parseFloat(upper),
        parseInt(count, 10),
        parseFloat(amount),
        parseInt(lev, 10),
      );

      await ctx.editMessageText(result, { parse_mode: 'HTML' });
    });

    // 그리드 시작 취소 버튼
    bot.action('grid_cancel', async (ctx) => {
      await ctx.editMessageText('↩️ 그리드 매매가 취소되었습니다.');
      await ctx.answerCbQuery('취소됨');
    });

    // 인라인 버튼 콜백 처리
    bot.action(/^grid_approve:(\d+)$/, async (ctx) => {
      const callbackUserId = ctx.from?.id;
      if (!callbackUserId || !this.isAdmin(callbackUserId)) {
        await ctx.answerCbQuery('🔒 관리자만 사용할 수 있습니다.');
        return;
      }

      const telegramId = parseInt(ctx.match[1], 10);
      const user = await this.gridUserRepository.findOne({ where: { telegramId } });

      if (!user) {
        await ctx.answerCbQuery('⚠️ 유저를 찾을 수 없습니다.');
        return;
      }

      if (user.status === 'approved') {
        await ctx.answerCbQuery('⚠️ 이미 승인된 유저입니다.');
        return;
      }

      await this.gridUserRepository.update({ telegramId }, { status: 'approved' });

      // 버튼을 결과 텍스트로 교체
      const displayName = user.username ? `@${user.username}` : `${telegramId}`;
      await ctx.editMessageText(
        `✅ <b>승인 완료</b>\n\n유저: ${displayName}\nID: <code>${telegramId}</code>`,
        { parse_mode: 'HTML' },
      );
      await ctx.answerCbQuery('승인 완료');
      this.logger.log(`User approved via button: ${telegramId}`);

      try {
        await this.telegramService.sendMessageTo(
          telegramId,
          '🎉 가입이 승인되었습니다!\n\n' +
            '/setkey 로 API 키를 등록하면 매매를 시작할 수 있습니다.',
        );
      } catch {
        this.logger.warn(`Failed to notify user ${telegramId}`);
      }
    });

    bot.action(/^grid_reject:(\d+)$/, async (ctx) => {
      const callbackUserId = ctx.from?.id;
      if (!callbackUserId || !this.isAdmin(callbackUserId)) {
        await ctx.answerCbQuery('🔒 관리자만 사용할 수 있습니다.');
        return;
      }

      const telegramId = parseInt(ctx.match[1], 10);
      const result = await this.gridUserRepository.delete({ telegramId, status: 'pending' as const });

      if (result.affected === 0) {
        await ctx.answerCbQuery('⚠️ 대기 중인 요청이 없습니다.');
        return;
      }

      await ctx.editMessageText(
        `❌ <b>거절 완료</b>\n\nID: <code>${telegramId}</code>`,
        { parse_mode: 'HTML' },
      );
      await ctx.answerCbQuery('거절 완료');
      this.logger.log(`User rejected via button: ${telegramId}`);

      try {
        await this.telegramService.sendMessageTo(
          telegramId,
          '❌ 가입 요청이 거절되었습니다.',
        );
      } catch {
        this.logger.warn(`Failed to notify user ${telegramId}`);
      }
    });

    this.logger.log('Grid trading commands registered');
  }

  private async handleSetKeyInput(
    ctx: any,
    userId: number,
    text: string,
  ): Promise<void> {
    const state = this.setKeyStates.get(userId);
    if (!state) return;

    // 입력 메시지 삭제 (키 노출 방지)
    await ctx.deleteMessage().catch(() => {});

    if (state.step === 'apiKey') {
      state.apiKey = text;
      state.step = 'privateKey';
      await ctx.reply(
        '✅ API Key 입력 완료\n\n' +
          '📌 <b>Private Key</b>를 입력하세요:\n' +
          '(Base58 형식의 Solana 키)',
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (state.step === 'privateKey') {
      const apiKey = state.apiKey!;
      const privateKey = text;
      this.setKeyStates.delete(userId);

      // 키 유효성 검증
      try {
        const decoded = bs58.decode(privateKey);
        Keypair.fromSecretKey(decoded);
      } catch {
        await ctx.reply('❌ 유효하지 않은 Private Key입니다. Base58 형식의 Solana 키를 입력하세요.\n\n/setkey 로 다시 시도하세요.');
        return;
      }

      try {
        const encryptionKey = this.configService.getOrThrow<string>(
          'GRID_ENCRYPTION_KEY',
        );

        const encryptedApiKey = encrypt(apiKey, encryptionKey);
        const encryptedPrivateKey = encrypt(privateKey, encryptionKey);

        await this.gridUserRepository.update(
          { telegramId: userId },
          { encryptedApiKey, encryptedPrivateKey },
        );

        this.pacificaClientFactory.removeClient(userId);

        await ctx.reply('✅ API 키가 등록되었습니다. /trade 로 매매를 시작할 수 있습니다.');
        this.logger.log(`User ${userId} set API keys`);
      } catch (error) {
        this.logger.error(`SetKey failed for user ${userId}: ${error.message}`);
        await ctx.reply('❌ 키 등록 실패. /setkey 로 다시 시도해주세요.');
      }
    }
  }

  private async handleJoin(ctx: any, userId: number): Promise<void> {
    const existing = await this.gridUserRepository.findOne({
      where: { telegramId: userId },
    });

    if (existing?.status === 'approved') {
      await ctx.reply('✅ 이미 승인된 유저입니다.');
      return;
    }

    if (existing?.status === 'pending') {
      await ctx.reply('⏳ 이미 가입 요청이 접수되었습니다. 관리자 승인을 기다려주세요.');
      return;
    }

    const username = ctx.from?.username ?? null;
    const user = this.gridUserRepository.create({
      telegramId: userId,
      username,
      status: 'pending',
    });
    await this.gridUserRepository.save(user);

    await ctx.reply('✅ 가입 요청이 접수되었습니다. 관리자 승인을 기다려주세요.');
    this.logger.log(`Join request from user ${userId} (@${username})`);

    // 관리자에게 버튼 알림
    if (this.adminId) {
      const displayName = username ? `@${username}` : `${userId}`;
      await this.telegramService.sendMessageWithButtons(
        this.adminId,
        `📩 <b>가입 요청</b>\n\n` +
          `유저: ${displayName}\n` +
          `ID: <code>${userId}</code>`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ 승인', `grid_approve:${userId}`),
          Markup.button.callback('❌ 거절', `grid_reject:${userId}`),
        ]),
      );
    }
  }

  private async handleKick(ctx: any, args: string[]): Promise<void> {
    if (args.length < 1) {
      await ctx.reply('❌ 사용법: /kick <텔레그램 유저 ID>');
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
      await ctx.reply('📋 등록된 유저가 없습니다.\n\n유저가 /join 으로 가입 요청을 보내면 승인할 수 있습니다.');
      return;
    }

    const list = users
      .map(
        (u, i) => {
          let status = '';
          if (u.status === 'pending') {
            status = '⏳ 승인대기';
          } else if (u.encryptedPrivateKey) {
            status = '🔑';
          } else {
            status = '⚠️ 키 미등록';
          }
          return `${i + 1}. ${u.telegramId}${u.username ? ` (@${u.username})` : ''} ${status}`;
        },
      )
      .join('\n');

    await ctx.reply(
      `📋 허용된 유저 목록 (${users.length}명)\n\n${list}`,
    );
  }

  private async handleBalance(ctx: any, userId: number): Promise<void> {
    const result = await this.gridTradingService.getBalance(userId);
    await ctx.reply(result, { parse_mode: 'HTML' });
  }

  private async handleStart(
    ctx: any,
    userId: number,
  ): Promise<void> {
    // 위자드 시작 — 잔고 + 현재가 조회
    const state: StartWizardState = { step: 'symbol' };
    this.wizardStates.set(userId, state);

    const symbols = ['BTC', 'ETH', 'SOL'];
    const [balanceResult, ...prices] = await Promise.allSettled([
      this.gridTradingService.getAvailableBalance(userId),
      ...symbols.map((s) => this.gridTradingService.getPrice(s)),
    ]);

    const balance = balanceResult.status === 'fulfilled' && balanceResult.value
      ? balanceResult.value : null;
    state.balance = balance ?? '조회 실패';
    state.balanceNum = balance ? parseFloat(balance.replace(/,/g, '')) : 0;

    const priceLines = symbols.map((s, i) => {
      const result = prices[i];
      const priceStr = result.status === 'fulfilled'
        ? `$${(result.value as number).toLocaleString()}`
        : '조회 실패';
      return `${s}: ${priceStr}`;
    }).join('\n');

    const balanceLine = `💳 <b>내 잔고:</b> $${state.balance}`;

    await ctx.reply(
      `📊 <b>그리드 매매 설정</b>\n\n${balanceLine}\n\n💰 <b>현재가</b>\n${priceLines}\n\n종목을 선택하세요:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('BTC', 'grid_sym:BTC'),
            Markup.button.callback('ETH', 'grid_sym:ETH'),
            Markup.button.callback('SOL', 'grid_sym:SOL'),
          ],
          [
            Markup.button.callback('↩️ 취소', 'grid_wizard_cancel'),
          ],
        ]),
      },
    );
  }

  private async handleWizardInput(ctx: any, userId: number, text: string): Promise<void> {
    const state = this.wizardStates.get(userId);
    if (!state) return;

    const value = parseFloat(text);

    switch (state.step) {
      case 'lowerPrice': {
        if (isNaN(value)) {
          await ctx.reply('❌ 숫자를 입력해주세요.');
          return;
        }
        state.lowerPrice = value;
        state.step = 'upperPrice';
        await ctx.reply(
          `${this.balanceHeader(state)}✅ 하한가: $${value}\n\n📈 <b>상한가</b>를 입력하세요:`,
          { parse_mode: 'HTML' },
        );
        break;
      }
      case 'upperPrice': {
        if (isNaN(value)) {
          await ctx.reply('❌ 숫자를 입력해주세요.');
          return;
        }
        if (value <= state.lowerPrice!) {
          await ctx.reply('❌ 상한가는 하한가보다 높아야 합니다. 다시 입력하세요.');
          return;
        }
        state.upperPrice = value;
        state.step = 'gridCount';

        const lower = state.lowerPrice!;
        const upper = value;
        const curPrice = state.currentPrice;
        const minOrder = state.minOrderSize ?? 10;
        const bal = state.balanceNum ?? 0;
        const allCounts = [3, 5, 10, 15, 20, 30];

        // 잔고 기준 가능한 그리드만 필터 (최소 주문금액 * (그리드수+1) <= 잔고)
        const availableCounts = allCounts.filter((c) => minOrder * (c + 1) <= bal);

        let gridInfo = '';
        if (curPrice) {
          gridInfo = '\n\n';
          for (const c of allCounts) {
            const interval = (upper - lower) / c;
            let bidCount = 0;
            let askCount = 0;
            for (let i = 0; i <= c; i++) {
              const price = lower + interval * i;
              if (price < curPrice) bidCount++;
              else askCount++;
            }
            const totalOrders = bidCount + askCount;
            const minInvest = minOrder * (c + 1);
            const available = minInvest <= bal;
            const mark = available ? '✅' : '🚫';
            gridInfo += `${mark} ${c}개: 간격 $${interval.toFixed(2)} / 매수 ${bidCount} 매도 ${askCount} (최소 $${minInvest})\n`;
          }
        }

        const explanation = curPrice
          ? `\n💡 그리드 N개 선택 → 범위를 N등분 → <b>N+1건</b> 주문 생성\n현재가($${curPrice.toLocaleString()}) 아래는 매수, 위는 매도\n📌 최소 주문금액: $${minOrder}`
          : '';

        if (availableCounts.length === 0) {
          await ctx.reply(
            `${this.balanceHeader(state)}❌ 잔고가 부족합니다.\n\n최소 투자금: $${minOrder * (allCounts[0] + 1)} (${allCounts[0]}개 그리드 = ${allCounts[0] + 1}건 주문)`,
            { parse_mode: 'HTML' },
          );
          this.wizardStates.delete(userId);
          return;
        }

        // 버튼을 3개씩 한 줄로 배치
        const buttonRows: ReturnType<typeof Markup.button.callback>[][] = [];
        let row: ReturnType<typeof Markup.button.callback>[] = [];
        for (const c of availableCounts) {
          row.push(Markup.button.callback(`${c}개`, `grid_count:${c}`));
          if (row.length === 3) {
            buttonRows.push(row);
            row = [];
          }
        }
        if (row.length > 0) buttonRows.push(row);

        await ctx.reply(
          `${this.balanceHeader(state)}✅ 상한가: $${value}\n\n📏 <b>그리드 수</b>를 선택하세요:${gridInfo}${explanation}`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttonRows),
          },
        );
        break;
      }
      case 'gridCount': {
        const intValue = parseInt(text, 10);
        if (isNaN(intValue) || intValue < 2 || intValue > 50) {
          await ctx.reply('❌ 그리드 수는 2~50 사이의 숫자를 입력해주세요.');
          return;
        }
        state.gridCount = intValue;
        state.step = 'totalAmount';
        await ctx.reply(
          `${this.balanceHeader(state)}✅ 그리드 수: ${intValue}개\n\n💰 <b>총 투자금</b>을 입력하세요 (USD):`,
          { parse_mode: 'HTML' },
        );
        break;
      }
      case 'totalAmount': {
        if (isNaN(value) || value <= 0) {
          await ctx.reply('❌ 0보다 큰 숫자를 입력해주세요.');
          return;
        }
        state.totalAmount = value;
        state.step = 'leverage';
        await ctx.reply(
          `${this.balanceHeader(state)}✅ 투자금: $${value}\n\n⚡ <b>레버리지</b>를 선택하세요:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('1x', 'grid_lev:1'),
                Markup.button.callback('2x', 'grid_lev:2'),
                Markup.button.callback('3x', 'grid_lev:3'),
                Markup.button.callback('5x', 'grid_lev:5'),
                Markup.button.callback('10x', 'grid_lev:10'),
              ],
            ]),
          },
        );
        break;
      }
      default:
        break;
    }
  }

  private async showPreview(ctx: any, userId: number, leverage: number): Promise<void> {
    const state = this.wizardStates.get(userId);
    if (!state) return;

    const { symbol, lowerPrice, upperPrice, gridCount, totalAmount } = state;

    const preview = await this.gridTradingService.preview(
      userId, symbol!, lowerPrice!, upperPrice!, gridCount!, totalAmount!, leverage,
    );

    this.wizardStates.delete(userId);

    if (preview.startsWith('❌') || preview.startsWith('⚠️')) {
      await ctx.reply(preview, { parse_mode: 'HTML' });
      return;
    }

    const callbackData = `grid_confirm:${symbol}:${lowerPrice}:${upperPrice}:${gridCount}:${totalAmount}:${leverage}`;
    await ctx.reply(preview, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        Markup.button.callback('🟢 매매 시작', callbackData),
        Markup.button.callback('↩️ 취소', 'grid_cancel'),
      ]),
    });
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
