import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class GridSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint', unique: true })
  telegramId: number;

  @Column()
  symbol: string;

  @Column({ type: 'float' })
  lowerPrice: number;

  @Column({ type: 'float' })
  upperPrice: number;

  @Column()
  gridCount: number;

  @Column({ type: 'float' })
  totalAmount: number;

  @Column({ default: 1 })
  leverage: number;

  @Column({ type: 'float' })
  lotSize: number;

  @Column({ type: 'float', default: 1 })
  tickSize: number;

  @Column({ type: 'jsonb' })
  gridLevels: {
    price: number;
    side: 'bid' | 'ask';
    orderId: number | null;
    filled: boolean;
  }[];

  @Column({ default: 0 })
  fillCount: number;

  @Column({ type: 'float', default: 0 })
  totalProfit: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
