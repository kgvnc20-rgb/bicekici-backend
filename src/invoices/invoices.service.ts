
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class InvoicesService {
    constructor(private prisma: PrismaService) { }

    /**
     * Create Invoice (Stub: Paraşüt)
     */
    async createInvoice(jobId: number, userId: number) {
        // Stub: Create invoice record immediately as ISSUED
        const invoice = await this.prisma.invoice.create({
            data: {
                jobId,
                userId,
                email: 'test@test.com', // Fetch from user real email
                status: 'ISSUED',
                providerInvoiceId: 'parasut-mock-' + Date.now(),
                pdfUrl: 'https://example.com/invoice-stub.pdf'
            }
        });

        console.log('[INVOICE] E-Invoice issued:', invoice.id);
        return invoice;
    }

    async getInvoice(id: number) {
        return this.prisma.invoice.findUnique({ where: { id } });
    }
}
