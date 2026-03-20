import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity()
export class GridUser {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint', unique: true })
  telegramId: number;

  @Column({ nullable: true })
  username: string;

  @Column({ default: false })
  isAdmin: boolean;

  @Column({ nullable: true })
  encryptedApiKey: string;

  @Column({ nullable: true })
  encryptedPrivateKey: string;

  @CreateDateColumn()
  createdAt: Date;
}
