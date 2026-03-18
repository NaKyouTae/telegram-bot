import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BithumbController } from './bithumb.controller';
import { BithumbService } from './bithumb.service';
import { Notice } from '../database/entities/notice.entity';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([Notice])],
  controllers: [BithumbController],
  providers: [BithumbService],
  exports: [BithumbService],
})
export class BithumbModule {}
