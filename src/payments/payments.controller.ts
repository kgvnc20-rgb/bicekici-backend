
import { Controller, Post, Body, Get, Param, Query, Res, BadRequestException, UseGuards, Request } from '@nestjs/common';
import { Response } from 'express';
import { PaymentsService } from './payments.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { ProcessGuestPaymentDto, InitPaymentDto, MockConfirmPaymentDto } from './dto/payment.dto';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    @Get('provider-info')
    @ApiOperation({ summary: 'Get active payment provider info' })
    getProviderInfo() {
        return {
            provider: process.env.PAYMENT_PROVIDER || 'sandbox',
            isSandbox: (process.env.PAYMENT_PROVIDER || 'sandbox') === 'sandbox',
        };
    }

    @Post('init')
    @ApiOperation({ summary: 'Initialize payment for a quote' })
    async initPayment(@Body() body: InitPaymentDto) {
        return this.paymentsService.initPayment(body);
    }

    @Post('webhook')
    @ApiOperation({ summary: 'Handle payment provider webhook' })
    async handleWebhook(@Body() payload: any) {
        // Webhooks have provider-specific shapes — cannot validate with a DTO
        return this.paymentsService.handleWebhook(payload);
    }

    @Get('status/:jobId')
    @ApiOperation({ summary: 'Get payment status for a job' })
    async getPaymentStatus(@Param('jobId') jobId: string) {
        return this.paymentsService.getPaymentByJobId(Number(jobId));
    }

    /**
     * GET /payments/checkout-page/:token
     * Serves a full HTML page containing iyzico's checkoutFormContent.
     * Mobile WebView loads this URL to render checkout inside the app.
     */
    @Get('checkout-page/:token')
    @ApiOperation({ summary: 'Serve hosted checkout page for in-app WebView' })
    getCheckoutPage(
        @Param('token') token: string,
        @Res() res: Response,
    ) {
        const html = this.paymentsService.getCheckoutPage(token);
        if (!html) {
            res.status(404).send('<html><body><h2>Ödeme sayfası bulunamadı veya süresi dolmuş.</h2><p>Lütfen geri dönüp tekrar deneyin.</p></body></html>');
            return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    }

    @Post('guest-process')
    @ApiOperation({ summary: 'Process guest payment and create job (payment-first)' })
    async processGuestPayment(@Body() body: ProcessGuestPaymentDto) {
        return this.paymentsService.processGuestPayment(body.quoteData, body.guestInfo);
    }

    /**
     * POST /payments/mock/confirm
     * DEV ONLY: Simulate successful payment without card data.
     * Requires guestToken (role=GUEST).
     */
    @Post('mock/confirm')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Mock Confirm Payment (dev only) — creates job after payment' })
    async mockConfirmPayment(@Body() body: MockConfirmPaymentDto, @Request() req: any) {
        const provider = process.env.PAYMENT_PROVIDER || 'sandbox';
        if (provider !== 'sandbox' && provider !== 'mock') {
            throw new BadRequestException({
                errorCode: 'MOCK_DISABLED',
                message: 'Mock payment is not available in production mode',
            });
        }

        const user = req.user;
        return this.paymentsService.mockConfirmPayment(body.quoteData, user.role !== 'GUEST' ? user.userId : undefined);
    }

    /**
     * POST /payments/checkout/complete
     * Called by mobile/frontend after iyzico redirects back with a token.
     * Triggers CF Retrieve → job transition.
     */
    @Post('checkout/complete')
    @ApiOperation({ summary: 'Complete checkout after iyzico callback (client-side)' })
    async completeCheckout(@Body() body: { token: string }) {
        if (!body.token) {
            throw new BadRequestException('Token is required');
        }
        return this.paymentsService.handleWebhook({ token: body.token });
    }

    /**
     * POST /payments/checkout/return
     * Iyzico Checkout Form POSTs the token here after 3DS / card entry.
     * We finalize payment (CF Retrieve) and redirect the browser to the frontend.
     */
    @Post('checkout/return')
    @ApiOperation({ summary: 'Handle iyzico checkout form callback (POST → redirect)' })
    async checkoutReturn(
        @Body() body: any,
        @Query('token') queryToken: string,
        @Res() res: Response,
    ) {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const token = body?.token || queryToken;

        console.log(`[PaymentsController] checkout/return hit. token=${token ? token.substring(0, 20) + '...' : 'MISSING'}`);

        if (!token) {
            res.redirect(`${frontendUrl}/request/payment?error=missing_token`);
            return;
        }

        try {
            const result = await this.paymentsService.handleWebhook({ token });
            if (result.status === 'ok') {
                res.redirect(`${frontendUrl}/request/payment/callback?status=success&jobId=${result.jobId || ''}`);
            } else {
                res.redirect(`${frontendUrl}/request/payment/callback?status=fail&reason=${encodeURIComponent(result.reason || 'Ödeme doğrulanamadı')}`);
            }
        } catch (err: any) {
            console.error('[PaymentsController] checkout/return error:', err.message);
            res.redirect(`${frontendUrl}/request/payment/callback?status=fail&reason=${encodeURIComponent(err?.message || 'Ödeme hatası')}`);
        }
    }
}
