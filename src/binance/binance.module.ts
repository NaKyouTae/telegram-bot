import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BinanceService } from './binance.service';
import { Notice } from '../database/entities/notice.entity';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([Notice])],
  providers: [BinanceService],
})
export class BinanceModule {}
