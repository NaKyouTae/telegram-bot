import { Controller, Get } from '@nestjs/common';
import { BithumbService, BithumbNoticeRaw } from './bithumb.service';

@Controller('bithumb')
export class BithumbController {
  constructor(private bithumbService: BithumbService) {}

  @Get('notice')
  async getNotices(): Promise<BithumbNoticeRaw[]> {
    return this.bithumbService.fetchNotices();
  }
}
