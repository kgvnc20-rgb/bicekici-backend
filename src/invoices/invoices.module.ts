
import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../prisma.service';

@Module({
    controllers: [InvoicesController],
    providers: [InvoicesService, PrismaService],
    exports: [InvoicesService],
})
export class InvoicesModule { }
