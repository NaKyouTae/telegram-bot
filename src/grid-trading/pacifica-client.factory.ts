import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PacificaClient } from './pacifica.client';

@Injectable()
export class PacificaClientFactory {
  private readonly logger = new Logger(PacificaClientFactory.name);
  private readonly baseUrl: string;
  private clients = new Map<number, PacificaClient>();

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    const isTestnet =
      this.configService.get<string>('PACIFICA_TESTNET') === 'true';
    this.baseUrl = isTestnet
      ? 'https://test-api.pacifica.fi/api/v1'
      : 'https://api.pacifica.fi/api/v1';
  }

  getClient(userId: number, apiKey: string, privateKey: string): PacificaClient {
    const cached = this.clients.get(userId);
    if (cached) return cached;

    const client = new PacificaClient(this.httpService, this.baseUrl);
    client.initializeFromKeys(apiKey, privateKey);
    this.clients.set(userId, client);
    this.logger.log(`PacificaClient created for user ${userId}`);
    return client;
  }

  getPublicClient(): PacificaClient {
    return new PacificaClient(this.httpService, this.baseUrl);
  }

  removeClient(userId: number): void {
    this.clients.delete(userId);
  }
}
