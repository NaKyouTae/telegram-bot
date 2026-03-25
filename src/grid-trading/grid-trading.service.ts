import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PacificaClientFactory } from './pacifica-client.factory';
import { PacificaClient } from './pacifica.client';
import { TelegramService } from '../telegram/telegram.service';
import { GridUser } from '../database/entities/grid-user.entity';
import { GridSession } from '../database/entities/grid-session.entity';
import { decrypt } from './crypto.util';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface GridConfig {
  symbol: string;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  totalAmount: number;
  leverage: number;
  lotSize: number;
  tickSize: number;
}

interface GridLevel {
  price: number;
  side: 'bid' | 'ask';
  orderId: number | null;
  filled: boolean;
}

interface UserGridSession {
  config: GridConfig;
  gridLevels: GridLevel[];
  fillCount: number;
  totalProfit: number;
}

@Injectable()
export class GridTradingService implements OnModuleInit {
  private readonly logger = new Logger(GridTradingService.name);
  private sessions = new Map<number, UserGridSession>();

  constructor(
    private pacificaClientFactory: PacificaClientFactory,
    private telegramService: TelegramService,
    private configService: ConfigService,
    @InjectRepository(GridUser)
    private gridUserRepository: Repository<GridUser>,
    @InjectRepository(GridSession)
    private gridSessionRepository: Repository<GridSession>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.restoreSessions();
  }

  private async restoreSessions(): Promise<void> {
    try {
      const savedSessions = await this.gridSessionRepository.find();
      for (const saved of savedSessions) {
        const session: UserGridSession = {
          config: {
            symbol: saved.symbol,
            lowerPrice: saved.lowerPrice,
            upperPrice: saved.upperPrice,
            gridCount: saved.gridCount,
            totalAmount: saved.totalAmount,
            leverage: saved.leverage,
            lotSize: saved.lotSize,
            tickSize: saved.tickSize ?? 1,
          },
          gridLevels: saved.gridLevels,
          fillCount: saved.fillCount,
          totalProfit: saved.totalProfit,
        };
        this.sessions.set(Number(saved.telegramId), session);
        this.logger.log(`[User ${saved.telegramId}] Session restored: ${saved.symbol}`);
      }
      if (savedSessions.length > 0) {
        this.logger.log(`Restored ${savedSessions.length} grid session(s) from DB`);
      }
    } catch (error) {
      this.logger.error(`Failed to restore sessions: ${error.message}`);
    }
  }

  private async saveSessionToDb(userId: number, session: UserGridSession): Promise<void> {
    try {
      let entity = await this.gridSessionRepository.findOne({
        where: { telegramId: userId },
      });
      if (!entity) {
        entity = this.gridSessionRepository.create({ telegramId: userId });
      }
      entity.symbol = session.config.symbol;
      entity.lowerPrice = session.config.lowerPrice;
      entity.upperPrice = session.config.upperPrice;
      entity.gridCount = session.config.gridCount;
      entity.totalAmount = session.config.totalAmount;
      entity.leverage = session.config.leverage;
      entity.lotSize = session.config.lotSize;
      entity.tickSize = session.config.tickSize;
      entity.gridLevels = session.gridLevels;
      entity.fillCount = session.fillCount;
      entity.totalProfit = session.totalProfit;
      await this.gridSessionRepository.save(entity);
    } catch (error) {
      this.logger.error(`[User ${userId}] Failed to save session to DB: ${error.message}`);
    }
  }

  private async deleteSessionFromDb(userId: number): Promise<void> {
    try {
      await this.gridSessionRepository.delete({ telegramId: userId });
    } catch (error) {
      this.logger.error(`[User ${userId}] Failed to delete session from DB: ${error.message}`);
    }
  }

  private getEncryptionKey(): string {
    return this.configService.getOrThrow<string>('GRID_ENCRYPTION_KEY');
  }

  private async getClientForUser(userId: number): Promise<PacificaClient> {
    const user = await this.gridUserRepository.findOne({
      where: { telegramId: userId },
    });
    if (!user?.encryptedApiKey || !user?.encryptedPrivateKey) {
      throw new Error('KEY_NOT_SET');
    }

    const encryptionKey = this.getEncryptionKey();
    const apiKey = decrypt(user.encryptedApiKey, encryptionKey);
    const privateKey = decrypt(user.encryptedPrivateKey, encryptionKey);

    return this.pacificaClientFactory.getClient(userId, apiKey, privateKey);
  }

  async getPrice(symbol: string): Promise<number> {
    const client = this.pacificaClientFactory.getPublicClient();
    return client.getMarketPrice(symbol);
  }

  async getMinOrderSize(symbol: string): Promise<number> {
    const client = this.pacificaClientFactory.getPublicClient();
    const markets = await client.getMarkets();
    const market = markets.find((m) => m.symbol === symbol);
    return market ? parseFloat(market.min_order_size) : 10;
  }

  async getAvailableBalance(userId: number): Promise<string | null> {
    try {
      const client = await this.getClientForUser(userId);
      const accountInfo = await client.getAccountInfo();
      const available = accountInfo.available_to_spend ?? accountInfo.balance ?? '0';
      return parseFloat(available).toLocaleString();
    } catch {
      return null;
    }
  }

  async getBalance(userId: number): Promise<string> {
    try {
      const client = await this.getClientForUser(userId);

      const accountInfo = await client.getAccountInfo();
      const balance = accountInfo.balance ?? '0';
      const available = accountInfo.available_to_spend ?? balance;

      return (
        `💰 <b>잔고 조회</b>\n\n` +
        `총 잔고: $${parseFloat(balance).toLocaleString()}\n` +
        `사용 가능: $${parseFloat(available).toLocaleString()}`
      );
    } catch (error) {
      if (error.message === 'KEY_NOT_SET') {
        return '❌ API 키가 설정되지 않았습니다. /setkey 로 API 키를 등록하세요.';
      }
      const detail = error.response?.data?.error ?? error.message;
      return `❌ 잔고 조회 실패: ${escapeHtml(typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
    }
  }

  async preview(
    userId: number,
    symbol: string,
    lowerPrice: number,
    upperPrice: number,
    gridCount: number,
    totalAmount: number,
    leverage: number = 1,
  ): Promise<string> {
    if (this.sessions.has(userId)) {
      return '⚠️ 이미 그리드 매매가 실행 중입니다. 먼저 /stoptrade 로 중지하세요.';
    }

    let client: PacificaClient;
    try {
      client = await this.getClientForUser(userId);
    } catch (error) {
      if (error.message === 'KEY_NOT_SET') {
        return '❌ API 키가 설정되지 않았습니다. /setkey 로 API 키를 등록하세요.';
      }
      return `❌ 인증 실패: ${escapeHtml(error.message)}`;
    }

    if (lowerPrice >= upperPrice) {
      return '❌ 하한가는 상한가보다 낮아야 합니다.';
    }
    if (gridCount < 2 || gridCount > 50) {
      return '❌ 그리드 수는 2~50 사이여야 합니다.';
    }
    if (leverage < 1 || leverage > 50) {
      return '❌ 레버리지는 1~50 사이여야 합니다.';
    }

    try {
      const markets = await client.getMarkets();
      const marketInfo = markets.find((m) => m.symbol === symbol);
      if (!marketInfo) {
        return `❌ ${symbol} 마켓을 찾을 수 없습니다.`;
      }

      const minOrderSize = parseFloat(marketInfo.min_order_size);
      const orderCount = gridCount + 1;
      const amountPerGrid = totalAmount / orderCount;
      if (amountPerGrid < minOrderSize) {
        return (
          `❌ 주문당 금액($${amountPerGrid.toFixed(2)})이 최소 주문금액($${minOrderSize})보다 작습니다.\n\n` +
          `최소 투자금: $${(minOrderSize * orderCount).toFixed(0)} (${orderCount}건 × $${minOrderSize})`
        );
      }

      const accountInfo = await client.getAccountInfo();
      const available = parseFloat(accountInfo.available_to_spend ?? accountInfo.balance ?? '0');
      if (available < totalAmount) {
        return (
          `❌ 잔고가 부족합니다.\n\n` +
          `필요 금액: $${totalAmount.toFixed(2)}\n` +
          `사용 가능: $${available.toFixed(2)}\n` +
          `부족: $${(totalAmount - available).toFixed(2)}`
        );
      }

      const currentPrice = await client.getMarketPrice(symbol);
      const tickSize = parseFloat(marketInfo.tick_size);
      const gridInterval = (upperPrice - lowerPrice) / gridCount;
      let bidCount = 0;
      let askCount = 0;
      for (let i = 0; i <= gridCount; i++) {
        const price = this.roundToTickSize(lowerPrice + gridInterval * i, tickSize);
        if (price < currentPrice) bidCount++;
        else askCount++;
      }

      let gridDetail = '';
      for (let i = 0; i <= gridCount; i++) {
        const price = this.roundToTickSize(lowerPrice + gridInterval * i, tickSize);
        const side = price < currentPrice ? '🟢 매수' : '🔴 매도';
        const marker = (price <= currentPrice && price + gridInterval > currentPrice) ? ' ◀ 현재가' : '';
        gridDetail += `  $${price} ${side}${marker}\n`;
      }

      return (
        `📋 <b>그리드 매매 확인</b>\n\n` +
        `종목: <b>${symbol}</b>\n` +
        `현재가: $${currentPrice.toLocaleString()}\n` +
        `범위: $${lowerPrice.toLocaleString()} ~ $${upperPrice.toLocaleString()}\n` +
        `그리드 수: ${gridCount}개\n` +
        `그리드 간격: $${gridInterval.toFixed(2)}\n` +
        `매수 주문: ${bidCount}개 (현재가 아래)\n` +
        `매도 주문: ${askCount}개 (현재가 위)\n` +
        `주문당 금액: $${amountPerGrid.toFixed(2)}\n` +
        `총 투자금: $${totalAmount}\n` +
        `레버리지: ${leverage}x\n` +
        `사용 가능 잔고: $${available.toFixed(2)}\n\n` +
        `📊 <b>주문 배치 계획</b>\n` +
        `<pre>${gridDetail}</pre>\n` +
        `⚠️ /stoptrade 로 직접 중지해야 종료됩니다.\n` +
        `가격이 범위를 벗어나도 주문은 유지됩니다.`
      );
    } catch (error) {
      const detail = error.response?.data?.error ?? error.response?.data ?? error.message;
      return `❌ 미리보기 실패: ${escapeHtml(typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
    }
  }

  async start(
    userId: number,
    symbol: string,
    lowerPrice: number,
    upperPrice: number,
    gridCount: number,
    totalAmount: number,
    leverage: number = 1,
  ): Promise<string> {
    if (this.sessions.has(userId)) {
      return '⚠️ 이미 그리드 매매가 실행 중입니다. 먼저 /stoptrade 로 중지하세요.';
    }

    let client: PacificaClient;
    try {
      client = await this.getClientForUser(userId);
    } catch (error) {
      if (error.message === 'KEY_NOT_SET') {
        return '❌ API 키가 설정되지 않았습니다. /setkey 로 API 키를 등록하세요.';
      }
      return `❌ 인증 실패: ${escapeHtml(error.message)}`;
    }

    if (lowerPrice >= upperPrice) {
      return '❌ 하한가는 상한가보다 낮아야 합니다.';
    }

    if (gridCount < 2 || gridCount > 50) {
      return '❌ 그리드 수는 2~50 사이여야 합니다.';
    }

    if (leverage < 1 || leverage > 50) {
      return '❌ 레버리지는 1~50 사이여야 합니다.';
    }

    try {
      const markets = await client.getMarkets();
      const marketInfo = markets.find((m) => m.symbol === symbol);
      if (!marketInfo) {
        return `❌ ${symbol} 마켓을 찾을 수 없습니다.`;
      }
      const lotSize = parseFloat(marketInfo.lot_size);
      const tickSize = parseFloat(marketInfo.tick_size);

      const minOrderSize = parseFloat(marketInfo.min_order_size);
      const amountPerGrid = totalAmount / gridCount;

      if (amountPerGrid < minOrderSize) {
        return (
          `❌ 주문당 금액($${amountPerGrid.toFixed(2)})이 최소 주문금액($${minOrderSize})보다 작습니다.\n\n` +
          `최소 투자금: $${(minOrderSize * gridCount).toFixed(0)} (그리드 ${gridCount}개 × $${minOrderSize})`
        );
      }

      const accountInfo = await client.getAccountInfo();
      const available = parseFloat(accountInfo.available_to_spend ?? accountInfo.balance ?? '0');
      if (available < totalAmount) {
        return (
          `❌ 잔고가 부족합니다.\n\n` +
          `필요 금액: $${totalAmount.toFixed(2)}\n` +
          `사용 가능: $${available.toFixed(2)}\n` +
          `부족: $${(totalAmount - available).toFixed(2)}`
        );
      }

      const config: GridConfig = { symbol, lowerPrice, upperPrice, gridCount, totalAmount, leverage, lotSize, tickSize };

      await client.updateLeverage(symbol, leverage);
      this.logger.log(`[User ${userId}] Leverage set to ${leverage}x for ${symbol}`);

      const currentPrice = await client.getMarketPrice(symbol);
      const gridLevels = this.buildGridLevels(lowerPrice, upperPrice, gridCount, currentPrice, tickSize);

      const session: UserGridSession = {
        config,
        gridLevels,
        fillCount: 0,
        totalProfit: 0,
      };

      const failedOrders = await this.placeGridOrders(client, session);
      if (failedOrders === gridLevels.length) {
        return '❌ 모든 주문이 실패했습니다. 설정을 확인하세요.';
      }

      this.sessions.set(userId, session);
      await this.saveSessionToDb(userId, session);

      const gridInterval = (upperPrice - lowerPrice) / gridCount;
      const placedOrders = gridLevels.filter((l) => l.orderId !== null).length;

      return (
        `🟢 <b>그리드 매매 시작</b>\n\n` +
        `종목: ${symbol}\n` +
        `범위: $${lowerPrice.toLocaleString()} ~ $${upperPrice.toLocaleString()}\n` +
        `현재가: $${currentPrice.toLocaleString()}\n` +
        `그리드 수: ${gridCount}\n` +
        `그리드 간격: $${gridInterval.toFixed(2)}\n` +
        `주문당 금액: $${amountPerGrid.toFixed(2)}\n` +
        `총 투자금: $${totalAmount}\n` +
        `레버리지: ${leverage}x\n` +
        `배치된 주문: ${placedOrders}/${gridLevels.length}개`
      );
    } catch (error) {
      const detail = error.response?.data?.error ?? error.response?.data ?? error.message;
      this.logger.error(`[User ${userId}] Grid start failed: ${JSON.stringify(detail)}`);
      return `❌ 그리드 시작 실패: ${escapeHtml(typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
    }
  }

  async stop(userId: number): Promise<string> {
    const session = this.sessions.get(userId);
    if (!session) {
      return '⚠️ 실행 중인 그리드 매매가 없습니다.';
    }

    try {
      const client = await this.getClientForUser(userId);
      const openOrderCount = session.gridLevels.filter((l) => l.orderId !== null).length;
      const result = await client.cancelAllOrders(session.config.symbol);
      this.logger.log(`[User ${userId}] cancelAllOrders response: ${JSON.stringify(result)}`);

      const cancelledCount = result.cancelled_count ?? openOrderCount;

      const message =
        `🔴 <b>그리드 매매 중지</b>\n\n` +
        `종목: ${session.config.symbol}\n` +
        `취소된 주문: ${cancelledCount}개\n` +
        `총 체결 횟수: ${session.fillCount}회\n` +
        `예상 수익: $${session.totalProfit.toFixed(2)}`;

      this.sessions.delete(userId);
      await this.deleteSessionFromDb(userId);
      this.pacificaClientFactory.removeClient(userId);

      return message;
    } catch (error) {
      const detail = error.response?.data?.error ?? error.message;
      this.logger.error(`[User ${userId}] Grid stop failed: ${detail}`);
      return `❌ 그리드 중지 실패: ${escapeHtml(typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
    }
  }

  async getStatus(userId: number): Promise<string> {
    const session = this.sessions.get(userId);
    if (!session) {
      return '⚠️ 실행 중인 그리드 매매가 없습니다.';
    }

    try {
      const client = await this.getClientForUser(userId);
      const currentPrice = await client.getMarketPrice(session.config.symbol);
      const openOrders = await client.getOpenOrders();
      const gridOrders = openOrders.filter(
        (o) => o.symbol === session.config.symbol,
      );
      const bidOrders = gridOrders.filter((o) => o.side === 'bid').length;
      const askOrders = gridOrders.filter((o) => o.side === 'ask').length;

      return (
        `📊 <b>그리드 매매 상태</b>\n\n` +
        `종목: ${session.config.symbol}\n` +
        `범위: $${session.config.lowerPrice.toLocaleString()} ~ $${session.config.upperPrice.toLocaleString()}\n` +
        `현재가: $${currentPrice.toLocaleString()}\n` +
        `활성 주문: ${gridOrders.length}개 (매수 ${bidOrders} / 매도 ${askOrders})\n` +
        `체결 횟수: ${session.fillCount}회\n` +
        `예상 수익: $${session.totalProfit.toFixed(2)}`
      );
    } catch (error) {
      const detail = error.response?.data?.error ?? error.message;
      return `❌ 상태 조회 실패: ${escapeHtml(typeof detail === 'string' ? detail : JSON.stringify(detail))}`;
    }
  }

  private roundToTickSize(price: number, tickSize: number): number {
    return Math.round(price / tickSize) * tickSize;
  }

  private buildGridLevels(
    lowerPrice: number,
    upperPrice: number,
    gridCount: number,
    currentPrice: number,
    tickSize: number = 1,
  ): GridLevel[] {
    const levels: GridLevel[] = [];
    const interval = (upperPrice - lowerPrice) / gridCount;

    for (let i = 0; i <= gridCount; i++) {
      const rawPrice = lowerPrice + interval * i;
      const price = this.roundToTickSize(rawPrice, tickSize);
      const side = price < currentPrice ? 'bid' : 'ask';

      levels.push({
        price,
        side,
        orderId: null,
        filled: false,
      });
    }

    // tick size 반올림으로 중복 가격 제거
    const seen = new Set<number>();
    return levels.filter((l) => {
      if (seen.has(l.price)) return false;
      seen.add(l.price);
      return true;
    });
  }

  private ceilToLotSize(amount: number, lotSize: number): string {
    const ceiled = Math.ceil(amount / lotSize) * lotSize;
    const decimals = (lotSize.toString().split('.')[1] || '').length;
    return ceiled.toFixed(decimals);
  }

  private async placeGridOrders(
    client: PacificaClient,
    session: UserGridSession,
  ): Promise<number> {
    const amountPerGrid = session.config.totalAmount / (session.config.gridCount + 1);
    const lotSize = session.config.lotSize;
    let failCount = 0;

    for (const level of session.gridLevels) {
      if (level.filled) continue;

      try {
        const orderAmount = amountPerGrid / level.price;
        const result = await client.createLimitOrder({
          symbol: session.config.symbol,
          side: level.side,
          price: level.price.toString(),
          amount: this.ceilToLotSize(orderAmount, lotSize),
          tif: 'ALO',
        });

        level.orderId = result.order_id;
        this.logger.log(
          `Order placed: ${level.side} ${session.config.symbol} @ $${level.price} (ID: ${result.order_id})`,
        );
      } catch (error) {
        failCount++;
        const detail = error.response?.data?.error ?? error.message;
        this.logger.error(
          `Failed to place order at $${level.price}: ${detail}`,
        );
      }
    }

    return failCount;
  }

  private isMonitoring = false;

  @Cron(CronExpression.EVERY_5_SECONDS)
  async monitorOrders(): Promise<void> {
    if (this.isMonitoring) return;
    this.isMonitoring = true;
    try {
      await this.doMonitor();
    } finally {
      this.isMonitoring = false;
    }
  }

  private async doMonitor(): Promise<void> {
    for (const [userId, session] of this.sessions) {
      try {
        const client = await this.getClientForUser(userId);
        const openOrders = await client.getOpenOrders();
        const openOrderIds = new Set(openOrders.map((o) => o.order_id));
        const gridOrderIds = session.gridLevels.filter((l) => l.orderId).map((l) => l.orderId);
        this.logger.debug(
          `[User ${userId}] Grid orderIds: ${JSON.stringify(gridOrderIds)}, Open orderIds: ${JSON.stringify([...openOrderIds])}`,
        );
        const gridInterval =
          (session.config.upperPrice - session.config.lowerPrice) /
          session.config.gridCount;

        for (let idx = 0; idx < session.gridLevels.length; idx++) {
          const level = session.gridLevels[idx];
          if (!level.orderId || openOrderIds.has(level.orderId)) continue;

          // 주문이 사라짐 — 체결로 간주하기 전에 검증
          // 최근 배치한 주문이 즉시 사라진 경우(ALO 셀프트레이드 취소 등) 무시
          const oldSide = level.side;
          const oldOrderId = level.orderId;
          level.orderId = null;

          session.fillCount++;

          // 반대 주문은 인접 그리드 가격에 배치
          // 매수 체결 → 한 칸 위에 매도, 매도 체결 → 한 칸 아래에 매수
          const flipIdx = oldSide === 'bid' ? idx + 1 : idx - 1;
          const flipLevel = session.gridLevels[flipIdx];

          const amountPerGrid = session.config.totalAmount / (session.config.gridCount + 1);

          // 인접 레벨이 존재하고 주문이 없는 경우에만 반대 주문 배치
          if (flipLevel && !flipLevel.orderId) {
            const newSide: 'bid' | 'ask' = oldSide === 'bid' ? 'ask' : 'bid';

            session.totalProfit += gridInterval * (amountPerGrid / level.price);

            this.logger.log(
              `[User ${userId}] Order ${oldOrderId} filled: ${oldSide} @ $${level.price}. Placing ${newSide} @ $${flipLevel.price}`,
            );

            try {
              const orderAmount = amountPerGrid / flipLevel.price;
              const result = await client.createLimitOrder({
                symbol: session.config.symbol,
                side: newSide,
                price: flipLevel.price.toString(),
                amount: this.ceilToLotSize(orderAmount, session.config.lotSize),
                tif: 'ALO',
              });

              flipLevel.side = newSide;
              flipLevel.orderId = result.order_id;
            } catch (error) {
              const detail = error.response?.data?.error ?? error.message;
              this.logger.error(
                `[User ${userId}] Failed to place flip order at $${flipLevel.price}: ${detail}`,
              );
            }
          } else {
            this.logger.log(
              `[User ${userId}] Order ${oldOrderId} filled: ${oldSide} @ $${level.price}. No adjacent level for flip.`,
            );
          }

          await this.saveSessionToDb(userId, session);

          try {
            await this.telegramService.sendMessageTo(
              userId,
              `🔄 <b>그리드 체결</b>\n\n` +
                `${oldSide === 'bid' ? '매수' : '매도'} @ $${level.price}\n` +
                `체결 횟수: ${session.fillCount}회\n` +
                `예상 누적 수익: $${session.totalProfit.toFixed(2)}`,
            );
          } catch (error) {
            this.logger.error(`[User ${userId}] Failed to send notification: ${error.message}`);
          }
        }
      } catch (error) {
        const detail = error.response?.data?.error ?? error.message;
        this.logger.error(`[User ${userId}] Monitor failed: ${detail}`);
      }
    }
  }
}
