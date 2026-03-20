import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { ClassifierModule } from './classifier/classifier.module';
import { TelegramModule } from './telegram/telegram.module';
import { BithumbModule } from './bithumb/bithumb.module';
import { UpbitModule } from './upbit/upbit.module';
import { BinanceModule } from './binance/binance.module';
import { OkxModule } from './okx/okx.module';
import { CoinoneModule } from './coinone/coinone.module';
import { BitgetModule } from './bitget/bitget.module';
import { BybitModule } from './bybit/bybit.module';
import { CoinbaseModule } from './coinbase/coinbase.module';
import { HealthModule } from './health/health.module';
import { GridTradingModule } from './grid-trading/grid-trading.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    ClassifierModule,
    TelegramModule,
    UpbitModule,
    BithumbModule,
    BinanceModule,
    OkxModule,
    CoinoneModule,
    BitgetModule,
    BybitModule,
    CoinbaseModule,
    HealthModule,
    GridTradingModule,
  ],
})
export class AppModule {}
