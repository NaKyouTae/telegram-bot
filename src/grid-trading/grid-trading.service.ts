import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PacificaClientFactory } from './pacifica-client.factory';
import { PacificaClient } from './pacifica.client';
import { TelegramService } from '../telegram/telegram.service';
import { GridUser } from '../database/entities/grid-user.entity';
import { decrypt } from './crypto.util';

interface GridConfig {
  symbol: string;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  totalAmount: number;
  leverage: number;
  lotSize: number;
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
export class GridTradingService {
  private readonly logger = new Logger(GridTradingService.name);
  private sessions = new Map<number, UserGridSession>();

  constructor(
    private pacificaClientFactory: PacificaClientFactory,
    private telegramService: TelegramService,
    private configService: ConfigService,
    @InjectRepository(GridUser)
    private gridUserRepository: Repository<GridUser>,
  ) {}

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
        return '❌ API 키가 설정되지 않았습니다. /grid setkey <apiKey> <privateKey>로 설정하세요.';
      }
      const detail = error.response?.data?.error ?? error.message;
      return `❌ 잔고 조회 실패: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
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
      return '⚠️ 이미 그리드 매매가 실행 중입니다. 먼저 /grid stop으로 중지하세요.';
    }

    let client: PacificaClient;
    try {
      client = await this.getClientForUser(userId);
    } catch (error) {
      if (error.message === 'KEY_NOT_SET') {
        return '❌ API 키가 설정되지 않았습니다. /grid setkey <apiKey> <privateKey>로 설정하세요.';
      }
      return `❌ 인증 실패: ${error.message}`;
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

      const config: GridConfig = { symbol, lowerPrice, upperPrice, gridCount, totalAmount, leverage, lotSize };

      await client.updateLeverage(symbol, leverage);
      this.logger.log(`[User ${userId}] Leverage set to ${leverage}x for ${symbol}`);

      const currentPrice = await client.getMarketPrice(symbol);
      const gridLevels = this.buildGridLevels(lowerPrice, upperPrice, gridCount, currentPrice);

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
      return `❌ 그리드 시작 실패: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    }
  }

  async stop(userId: number): Promise<string> {
    const session = this.sessions.get(userId);
    if (!session) {
      return '⚠️ 실행 중인 그리드 매매가 없습니다.';
    }

    try {
      const client = await this.getClientForUser(userId);
      const result = await client.cancelAllOrders(session.config.symbol);

      const message =
        `🔴 <b>그리드 매매 중지</b>\n\n` +
        `종목: ${session.config.symbol}\n` +
        `취소된 주문: ${result.cancelled_count}개\n` +
        `총 체결 횟수: ${session.fillCount}회\n` +
        `예상 수익: $${session.totalProfit.toFixed(2)}`;

      this.sessions.delete(userId);
      this.pacificaClientFactory.removeClient(userId);

      return message;
    } catch (error) {
      const detail = error.response?.data?.error ?? error.message;
      this.logger.error(`[User ${userId}] Grid stop failed: ${detail}`);
      return `❌ 그리드 중지 실패: ${detail}`;
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
      return `❌ 상태 조회 실패: ${detail}`;
    }
  }

  private buildGridLevels(
    lowerPrice: number,
    upperPrice: number,
    gridCount: number,
    currentPrice: number,
  ): GridLevel[] {
    const levels: GridLevel[] = [];
    const interval = (upperPrice - lowerPrice) / gridCount;

    for (let i = 0; i <= gridCount; i++) {
      const price = lowerPrice + interval * i;
      const side = price < currentPrice ? 'bid' : 'ask';

      levels.push({
        price: parseFloat(price.toFixed(2)),
        side,
        orderId: null,
        filled: false,
      });
    }

    return levels;
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
    const amountPerGrid = session.config.totalAmount / session.config.gridCount;
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

  @Cron(CronExpression.EVERY_5_SECONDS)
  async monitorOrders(): Promise<void> {
    for (const [userId, session] of this.sessions) {
      try {
        const client = await this.getClientForUser(userId);
        const openOrders = await client.getOpenOrders();
        const openOrderIds = new Set(openOrders.map((o) => o.order_id));
        const gridInterval =
          (session.config.upperPrice - session.config.lowerPrice) /
          session.config.gridCount;

        for (const level of session.gridLevels) {
          if (!level.orderId || openOrderIds.has(level.orderId)) continue;

          level.filled = true;
          session.fillCount++;

          const oldSide = level.side;
          level.side = oldSide === 'bid' ? 'ask' : 'bid';
          level.orderId = null;
          level.filled = false;

          session.totalProfit += gridInterval * (session.config.totalAmount / session.config.gridCount / level.price);

          this.logger.log(
            `[User ${userId}] Order filled at $${level.price}. Flipping to ${level.side}. Total fills: ${session.fillCount}`,
          );

          try {
            const amountPerGrid =
              session.config.totalAmount / session.config.gridCount;
            const orderAmount = amountPerGrid / level.price;

            const result = await client.createLimitOrder({
              symbol: session.config.symbol,
              side: level.side,
              price: level.price.toString(),
              amount: this.ceilToLotSize(orderAmount, session.config.lotSize),
              tif: 'ALO',
            });

            level.orderId = result.order_id;
          } catch (error) {
            const detail = error.response?.data?.error ?? error.message;
            this.logger.error(
              `[User ${userId}] Failed to flip order at $${level.price}: ${detail}`,
            );
          }

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
