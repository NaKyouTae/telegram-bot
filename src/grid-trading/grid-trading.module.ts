import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GridTradingService } from './grid-trading.service';
import { GridTradingCommand } from './grid-trading.command';
import { PacificaClientFactory } from './pacifica-client.factory';
import { GridUser } from '../database/entities/grid-user.entity';
import { GridSession } from '../database/entities/grid-session.entity';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([GridUser, GridSession])],
  providers: [PacificaClientFactory, GridTradingService, GridTradingCommand],
})
export class GridTradingModule {}
