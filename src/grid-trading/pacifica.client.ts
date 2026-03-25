import { Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nacl = require('tweetnacl');

export interface OrderParams {
  symbol: string;
  side: 'bid' | 'ask';
  price: string;
  amount: string;
  tif?: 'GTC' | 'IOC' | 'ALO' | 'TOB';
  reduceOnly?: boolean;
}

export interface MarketInfo {
  symbol: string;
  min_order_size: string;
  tick_size: string;
  lot_size: string;
  max_leverage: number;
}

export class PacificaClient {
  private readonly logger = new Logger(PacificaClient.name);
  private keypair: Keypair | null = null;
  private account: string | null = null;
  private apiKey: string | null = null;
  private authHeaders: Record<string, string> = {};

  constructor(
    private httpService: HttpService,
    private baseUrl: string,
  ) {}

  initializeFromKeys(apiKey: string, privateKey: string): void {
    this.apiKey = apiKey;
    if (apiKey) {
      this.authHeaders['PF-API-KEY'] = apiKey;
    }

    const decoded = bs58.decode(privateKey);
    this.keypair = Keypair.fromSecretKey(decoded);
    this.account = this.keypair.publicKey.toBase58();
    this.logger.log(`Pacifica account initialized: ${this.account}`);
  }

  isConfigured(): boolean {
    return this.keypair !== null;
  }

  getAccount(): string | null {
    return this.account;
  }

  private sortObjectKeys(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map((item) => this.sortObjectKeys(item));
    const sorted: any = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = this.sortObjectKeys(obj[key]);
    }
    return sorted;
  }

  private sign(payload: Record<string, any>): string {
    const sorted = this.sortObjectKeys(payload);
    const message = JSON.stringify(sorted);
    const messageBytes = new TextEncoder().encode(message);
    const signature = nacl.sign.detached(
      messageBytes,
      this.keypair!.secretKey,
    );
    return bs58.encode(signature);
  }

  private buildSignedPayload(
    type: string,
    data: Record<string, any>,
  ): Record<string, any> {
    const timestamp = Date.now();
    const expiryWindow = 30000;

    const header = { type, timestamp, expiry_window: expiryWindow };
    const sigPayload = { ...header, data };
    const signature = this.sign(sigPayload);

    return {
      ...data,
      account: this.account,
      signature,
      timestamp,
      expiry_window: expiryWindow,
    };
  }

  async getMarkets(): Promise<MarketInfo[]> {
    const { data } = await firstValueFrom(
      this.httpService.get(`${this.baseUrl}/info`),
    );
    return data.data ?? data;
  }

  async getMarketPrice(symbol: string): Promise<number> {
    const { data } = await firstValueFrom(
      this.httpService.get(`${this.baseUrl}/trades`, {
        params: { symbol },
      }),
    );
    if (!data.data || data.data.length === 0) {
      throw new Error(`${symbol} 거래 데이터가 없습니다.`);
    }
    return parseFloat(data.data[0].price);
  }

  async getAccountInfo(): Promise<any> {
    const { data } = await firstValueFrom(
      this.httpService.get(
        `${this.baseUrl}/account?account=${this.account}`,
      ),
    );
    return data.data ?? data;
  }

  async getPositions(): Promise<any[]> {
    const { data } = await firstValueFrom(
      this.httpService.get(
        `${this.baseUrl}/positions?account=${this.account}`,
      ),
    );
    return data.data ?? data;
  }

  async getOpenOrders(): Promise<any[]> {
    const { data } = await firstValueFrom(
      this.httpService.get(
        `${this.baseUrl}/orders?account=${this.account}`,
      ),
    );
    const orders = data.data ?? data;
    // open 상태인 주문만 필터링 (체결/취소된 주문 제외)
    return Array.isArray(orders)
      ? orders.filter((o: any) => o.status === 'open' || o.status === 'new')
      : orders;
  }

  async createLimitOrder(params: OrderParams): Promise<{ order_id: number }> {
    const payload = this.buildSignedPayload('create_order', {
      symbol: params.symbol,
      side: params.side,
      price: params.price,
      amount: params.amount,
      tif: params.tif ?? 'ALO',
      reduce_only: params.reduceOnly ?? false,
    });

    const { data } = await firstValueFrom(
      this.httpService.post(`${this.baseUrl}/orders/create`, payload, {
      }),
    );
    return data;
  }

  async cancelOrder(
    symbol: string,
    orderId: number,
  ): Promise<{ success: boolean }> {
    const payload = this.buildSignedPayload('cancel_order', {
      symbol,
      order_id: orderId,
    });

    const { data } = await firstValueFrom(
      this.httpService.post(`${this.baseUrl}/orders/cancel`, payload, {
      }),
    );
    return data;
  }

  async updateLeverage(
    symbol: string,
    leverage: number,
  ): Promise<any> {
    const payload = this.buildSignedPayload('update_leverage', {
      symbol,
      leverage,
    });

    const { data } = await firstValueFrom(
      this.httpService.post(
        `${this.baseUrl}/account/leverage`,
        payload,
      ),
    );
    return data;
  }

  async cancelAllOrders(symbol: string): Promise<{ cancelled_count: number }> {
    const payload = this.buildSignedPayload('cancel_all_orders', {
      symbol,
      all_symbols: false,
      exclude_reduce_only: false,
    });

    const { data } = await firstValueFrom(
      this.httpService.post(`${this.baseUrl}/orders/cancel_all`, payload, {
      }),
    );
    return data;
  }
}
