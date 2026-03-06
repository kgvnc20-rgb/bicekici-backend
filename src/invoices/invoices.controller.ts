
import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Invoices')
@Controller('invoices')
export class InvoicesController {
    constructor(private readonly invoicesService: InvoicesService) { }

    @Post()
    @ApiOperation({ summary: 'Create invoice manually (optional)' })
    async createInvoice(@Body() body: any) {
        // Stub
        return { message: 'Invoice creation triggered' };
    }

    @Get(':id')
    async getInvoice(@Param('id') id: string) {
        return this.invoicesService.getInvoice(Number(id));
    }
}
