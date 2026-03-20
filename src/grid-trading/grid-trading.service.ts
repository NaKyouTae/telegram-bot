import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PacificaClient } from './pacifica.client';
import { TelegramService } from '../telegram/telegram.service';

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

@Injectable()
export class GridTradingService {
  private readonly logger = new Logger(GridTradingService.name);
  private config: GridConfig | null = null;
  private gridLevels: GridLevel[] = [];
  private isRunning = false;
  private fillCount = 0;
  private totalProfit = 0;

  constructor(
    private pacificaClient: PacificaClient,
    private telegramService: TelegramService,
  ) {}

  async getPrice(symbol: string): Promise<number> {
    return this.pacificaClient.getMarketPrice(symbol);
  }

  async start(
    symbol: string,
    lowerPrice: number,
    upperPrice: number,
    gridCount: number,
    totalAmount: number,
    leverage: number = 1,
  ): Promise<string> {
    if (!this.pacificaClient.isConfigured()) {
      return '❌ PACIFICA_PRIVATE_KEY가 .env에 설정되지 않았습니다.';
    }

    if (this.isRunning) {
      return '⚠️ 이미 그리드 매매가 실행 중입니다. 먼저 /grid stop으로 중지하세요.';
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

    this.fillCount = 0;
    this.totalProfit = 0;

    try {
      const markets = await this.pacificaClient.getMarkets();
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

      const accountInfo = await this.pacificaClient.getAccountInfo();
      const available = parseFloat(accountInfo.available_to_spend ?? accountInfo.balance ?? '0');
      if (available < totalAmount) {
        return (
          `❌ 잔고가 부족합니다.\n\n` +
          `필요 금액: $${totalAmount.toFixed(2)}\n` +
          `사용 가능: $${available.toFixed(2)}\n` +
          `부족: $${(totalAmount - available).toFixed(2)}`
        );
      }

      this.config = { symbol, lowerPrice, upperPrice, gridCount, totalAmount, leverage, lotSize };

      await this.pacificaClient.updateLeverage(symbol, leverage);
      this.logger.log(`Leverage set to ${leverage}x for ${symbol}`);

      const currentPrice = await this.pacificaClient.getMarketPrice(symbol);
      this.gridLevels = this.buildGridLevels(
        lowerPrice,
        upperPrice,
        gridCount,
        currentPrice,
      );

      const failedOrders = await this.placeGridOrders();
      if (failedOrders === this.gridLevels.length) {
        this.config = null;
        this.gridLevels = [];
        return '❌ 모든 주문이 실패했습니다. 설정을 확인하세요.';
      }

      this.isRunning = true;

      const gridInterval = (upperPrice - lowerPrice) / gridCount;
      const placedOrders = this.gridLevels.filter((l) => l.orderId !== null).length;

      const message =
        `🟢 <b>그리드 매매 시작</b>\n\n` +
        `종목: ${symbol}\n` +
        `범위: $${lowerPrice.toLocaleString()} ~ $${upperPrice.toLocaleString()}\n` +
        `현재가: $${currentPrice.toLocaleString()}\n` +
        `그리드 수: ${gridCount}\n` +
        `그리드 간격: $${gridInterval.toFixed(2)}\n` +
        `주문당 금액: $${amountPerGrid.toFixed(2)}\n` +
        `총 투자금: $${totalAmount}\n` +
        `레버리지: ${leverage}x\n` +
        `배치된 주문: ${placedOrders}/${this.gridLevels.length}개`;

      return message;
    } catch (error) {
      this.isRunning = false;
      const detail = error.response?.data?.error ?? error.response?.data ?? error.message;
      this.logger.error(`Grid start failed: ${JSON.stringify(detail)}`);
      return `❌ 그리드 시작 실패: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    }
  }

  async stop(): Promise<string> {
    if (!this.isRunning || !this.config) {
      return '⚠️ 실행 중인 그리드 매매가 없습니다.';
    }

    try {
      const result = await this.pacificaClient.cancelAllOrders(
        this.config.symbol,
      );

      const message =
        `🔴 <b>그리드 매매 중지</b>\n\n` +
        `종목: ${this.config.symbol}\n` +
        `취소된 주문: ${result.cancelled_count}개\n` +
        `총 체결 횟수: ${this.fillCount}회\n` +
        `예상 수익: $${this.totalProfit.toFixed(2)}`;

      this.isRunning = false;
      this.config = null;
      this.gridLevels = [];

      return message;
    } catch (error) {
      const detail = error.response?.data?.error ?? error.message;
      this.logger.error(`Grid stop failed: ${detail}`);
      return `❌ 그리드 중지 실패: ${detail}`;
    }
  }

  async getStatus(): Promise<string> {
    if (!this.isRunning || !this.config) {
      return '⚠️ 실행 중인 그리드 매매가 없습니다.';
    }

    try {
      const currentPrice = await this.pacificaClient.getMarketPrice(
        this.config.symbol,
      );
      const openOrders = await this.pacificaClient.getOpenOrders();
      const gridOrders = openOrders.filter(
        (o) => o.symbol === this.config!.symbol,
      );
      const bidOrders = gridOrders.filter((o) => o.side === 'bid').length;
      const askOrders = gridOrders.filter((o) => o.side === 'ask').length;

      return (
        `📊 <b>그리드 매매 상태</b>\n\n` +
        `종목: ${this.config.symbol}\n` +
        `범위: $${this.config.lowerPrice.toLocaleString()} ~ $${this.config.upperPrice.toLocaleString()}\n` +
        `현재가: $${currentPrice.toLocaleString()}\n` +
        `활성 주문: ${gridOrders.length}개 (매수 ${bidOrders} / 매도 ${askOrders})\n` +
        `체결 횟수: ${this.fillCount}회\n` +
        `예상 수익: $${this.totalProfit.toFixed(2)}`
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

  private async placeGridOrders(): Promise<number> {
    const amountPerGrid =
      this.config!.totalAmount / this.config!.gridCount;
    const lotSize = this.config!.lotSize;
    let failCount = 0;

    for (const level of this.gridLevels) {
      if (level.filled) continue;

      try {
        const orderAmount = amountPerGrid / level.price;
        const result = await this.pacificaClient.createLimitOrder({
          symbol: this.config!.symbol,
          side: level.side,
          price: level.price.toString(),
          amount: this.ceilToLotSize(orderAmount, lotSize),
          tif: 'ALO',
        });

        level.orderId = result.order_id;
        this.logger.log(
          `Order placed: ${level.side} ${this.config!.symbol} @ $${level.price} (ID: ${result.order_id})`,
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
    if (!this.isRunning || !this.config) return;

    try {
      const openOrders = await this.pacificaClient.getOpenOrders();
      const openOrderIds = new Set(openOrders.map((o) => o.order_id));
      const gridInterval =
        (this.config.upperPrice - this.config.lowerPrice) /
        this.config.gridCount;

      for (const level of this.gridLevels) {
        if (!level.orderId || openOrderIds.has(level.orderId)) continue;

        // 주문이 체결됨
        level.filled = true;
        this.fillCount++;

        const oldSide = level.side;
        level.side = oldSide === 'bid' ? 'ask' : 'bid';
        level.orderId = null;
        level.filled = false;

        this.totalProfit += gridInterval * (this.config.totalAmount / this.config.gridCount / level.price);

        this.logger.log(
          `Order filled at $${level.price}. Flipping to ${level.side}. Total fills: ${this.fillCount}`,
        );

        // 반대 주문 배치
        try {
          const amountPerGrid =
            this.config.totalAmount / this.config.gridCount;
          const orderAmount = amountPerGrid / level.price;

          const result = await this.pacificaClient.createLimitOrder({
            symbol: this.config.symbol,
            side: level.side,
            price: level.price.toString(),
            amount: this.ceilToLotSize(orderAmount, this.config.lotSize),
            tif: 'ALO',
          });

          level.orderId = result.order_id;
        } catch (error) {
          const detail = error.response?.data?.error ?? error.message;
          this.logger.error(
            `Failed to flip order at $${level.price}: ${detail}`,
          );
        }

        await this.telegramService.sendMessage(
          `🔄 <b>그리드 체결</b>\n\n` +
            `${oldSide === 'bid' ? '매수' : '매도'} @ $${level.price}\n` +
            `체결 횟수: ${this.fillCount}회\n` +
            `예상 누적 수익: $${this.totalProfit.toFixed(2)}`,
        );
      }
    } catch (error) {
      const detail = error.response?.data?.error ?? error.message;
      this.logger.error(`Monitor failed: ${detail}`);
    }
  }
}
