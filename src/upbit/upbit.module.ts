import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UpbitController } from './upbit.controller';
import { UpbitService } from './upbit.service';
import { Notice } from '../database/entities/notice.entity';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([Notice])],
  controllers: [UpbitController],
  providers: [UpbitService],
  exports: [UpbitService],
})
export class UpbitModule {}
