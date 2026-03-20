import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GridTradingService } from './grid-trading.service';
import { GridTradingCommand } from './grid-trading.command';
import { PacificaClientFactory } from './pacifica-client.factory';
import { GridUser } from '../database/entities/grid-user.entity';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([GridUser])],
  providers: [PacificaClientFactory, GridTradingService, GridTradingCommand],
})
export class GridTradingModule {}
