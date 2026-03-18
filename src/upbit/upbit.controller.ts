import { Controller, Get } from '@nestjs/common';
import { UpbitService, UpbitNoticeRaw } from './upbit.service';

@Controller('upbit')
export class UpbitController {
  constructor(private upbitService: UpbitService) {}

  @Get('notice')
  async getNotices(): Promise<UpbitNoticeRaw[]> {
    return this.upbitService.fetchNotices();
  }
}
