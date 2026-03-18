import { Module, Global } from '@nestjs/common';
import { ClassifierService } from './classifier.service';

@Global()
@Module({
  providers: [ClassifierService],
  exports: [ClassifierService],
})
export class ClassifierModule {}
