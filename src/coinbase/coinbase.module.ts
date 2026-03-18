import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoinbaseService } from './coinbase.service';
import { Notice } from '../database/entities/notice.entity';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([Notice])],
  providers: [CoinbaseService],
})
export class CoinbaseModule {}
