
import { Injectable, BadRequestException, Inject, forwardRef, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { AuthService } from '../auth/auth.service';
import { PaymentStatus } from '@prisma/client';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';
import { IdempotencyService } from '../common/idempotency.service';

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger('PaymentsService');

    /**
     * In-memory cache for iyzico checkoutFormContent.
     * Keyed by provider token, auto-cleaned after 30 minutes.
     */
    private checkoutPages = new Map<string, { html: string; createdAt: number }>();
    private readonly CHECKOUT_PAGE_TTL = 30 * 60 * 1000; // 30 minutes

    constructor(
        private prisma: PrismaService,
        private jobsService: JobsService,
        @Inject(forwardRef(() => AuthService))
        private authService: AuthService,
        @Inject(forwardRef(() => RealtimeGateway))
        private realtimeGateway: RealtimeGateway,
        @Inject(PAYMENT_PROVIDER) private paymentProvider: PaymentProvider,
        private idempotencyService: IdempotencyService,
    ) {
        // Periodic cleanup of expired checkout pages
        setInterval(() => {
            const now = Date.now();
            for (const [key, val] of this.checkoutPages) {
                if (now - val.createdAt > this.CHECKOUT_PAGE_TTL) {
                    this.checkoutPages.delete(key);
                }
            }
        }, 5 * 60 * 1000); // cleanup every 5 min
    }

    /**
     * Initialize payment for a quote.
     * Creates job in PENDING_PAYMENT state, then calls the configured PaymentProvider.
     * Job transitions to MATCHING when handleWebhook confirms the payment.
     */
    async initPayment(quoteData: any) {
        // 1. Create job first (PENDING_PAYMENT) so we have a real jobId for the FK
        const job = await this.jobsService.createQuoteJob({
            customerId: quoteData.customerId || null,
            pickupAddress: quoteData.pickupAddress,
            dropoffAddress: quoteData.dropoffAddress,
            pickupLat: quoteData.pickupLat,
            pickupLng: quoteData.pickupLng,
            dropoffLat: quoteData.dropoffLat,
            dropoffLng: quoteData.dropoffLng,
            pickupPlaceId: quoteData.pickupPlaceId,
            dropoffPlaceId: quoteData.dropoffPlaceId,
            routePolyline: quoteData.routePolyline,
            vehicleType: quoteData.vehicleType,
            distanceKm: quoteData.distanceKm,
            durationMin: quoteData.durationMin,
        });

        const amount = quoteData.estimatedPrice || quoteData.amount || Number(job.estimatedPrice);

        // 2. Initiate payment with the real jobId
        const result = await this.paymentProvider.initiate({
            jobId: job.id,
            amount,
            currency: 'TRY',
            description: `BiÇekici - Çekici Hizmeti #${job.id}`,
            // Use API_URL for callbackUrl so mobile WebView can reach it
            // (mobile can't access localhost:3000 frontend dev server)
            callbackUrl: `${process.env.API_URL || process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3000}`}/payments/checkout/return`,
            buyer: {
                firstName: quoteData.firstName || 'Guest',
                lastName: quoteData.lastName || '',
                phone: quoteData.phone || '',
                email: quoteData.email,
            },
        });

        // 3. Create Payment record with the real jobId
        const payment = await this.prisma.payment.create({
            data: {
                jobId: job.id,
                amount,
                currency: 'TRY',
                provider: this.paymentProvider.name,
                providerPaymentId: result.providerPaymentId,
                status: result.status === 'CAPTURED' ? 'CAPTURED' : 'INITIATED',
            },
        });

        this.logger.log(`💳 Payment initiated: job #${job.id}, provider=${this.paymentProvider.name}, status=${result.status}`);

        // Cache checkoutFormContent for hosted checkout page
        if (result.htmlContent && result.providerPaymentId) {
            this.checkoutPages.set(result.providerPaymentId, {
                html: result.htmlContent,
                createdAt: Date.now(),
            });
            this.logger.log(`📄 Checkout page cached for token: ${result.providerPaymentId.substring(0, 20)}...`);
        }

        return {
            paymentId: payment.id,
            jobId: job.id,
            providerPaymentId: result.providerPaymentId,
            status: result.status,
            actionUrl: result.actionUrl,
            htmlContent: result.htmlContent,
        };
    }

    /**
     * Handle callback/webhook from payment provider.
     * On success: transitions job from PENDING_PAYMENT → MATCHING and dispatches.
     */
    async handleWebhook(payload: any) {
        this.logger.log(`Webhook received from ${this.paymentProvider.name}`);

        const result = await this.paymentProvider.handleCallback(payload);

        // Find the payment record.
        // We stored the iyzico TOKEN as providerPaymentId during initPayment.
        // CF Retrieve returns a different paymentId, so try both:
        //   1. First by the providerPaymentId from CF Retrieve result
        //   2. Then by the original token from the payload (what we stored)
        let payment = await this.prisma.payment.findFirst({
            where: { providerPaymentId: result.providerPaymentId },
            include: { job: true },
        });

        if (!payment && payload.token) {
            this.logger.log(`Looking up payment by original token: ${payload.token.substring(0, 20)}...`);
            payment = await this.prisma.payment.findFirst({
                where: { providerPaymentId: payload.token },
                include: { job: true },
            });
        }

        if (!payment) {
            this.logger.warn(`Payment not found for providerPaymentId: ${result.providerPaymentId}`);
            return { status: 'ignored', reason: 'payment_not_found' };
        }

        if (result.status === 'CAPTURED') {
            // Update payment status
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: { status: 'CAPTURED' },
            });

            // If job exists and is PENDING_PAYMENT, transition to MATCHING and dispatch
            if (payment.job && payment.job.status === 'PENDING_PAYMENT') {
                await this.prisma.serviceRequest.update({
                    where: { id: payment.job.id },
                    data: { status: 'MATCHING' },
                });

                // Dispatch to nearby drivers
                await this.jobsService.dispatchJob(payment.job.id);

                // Notify via socket
                this.realtimeGateway.notifyJobUpdate(payment.job.id, 'job:status_changed', {
                    jobId: payment.job.id,
                    status: 'MATCHING',
                    notificationText: 'Ödemeniz alındı, uygun çekici aranıyor.',
                });

                this.logger.log(`✅ Payment confirmed for job #${payment.job.id} → MATCHING`);
            }

            return { status: 'ok', jobId: payment.jobId };
        }

        // Payment failed
        if (result.status === 'FAILED') {
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: { status: 'FAILED' },
            });

            // If job exists and is PENDING_PAYMENT, mark as CANCELED
            if (payment.job && payment.job.status === 'PENDING_PAYMENT') {
                await this.prisma.serviceRequest.update({
                    where: { id: payment.job.id },
                    data: { status: 'CANCELED' },
                });
            }

            this.logger.warn(`❌ Payment failed for job #${payment.jobId}: ${result.errorMessage}`);
            return { status: 'failed', reason: result.errorMessage };
        }

        return { status: 'ignored' };
    }

    async getPaymentByJobId(jobId: number) {
        return this.prisma.payment.findFirst({
            where: { jobId },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Serve a full HTML checkout page for the given provider token.
     * Mobile WebView loads this URL instead of injecting raw HTML.
     */
    getCheckoutPage(token: string): string | null {
        const cached = this.checkoutPages.get(token);
        if (!cached) {
            this.logger.warn(`Checkout page not found for token: ${token?.substring(0, 20)}...`);
            return null;
        }

        // Build a complete HTML page
        return `<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Güvenli Ödeme</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #FFFFFF;
            color: #333;
            padding: 12px;
            min-height: 100vh;
        }
        #iyzipay-checkout-form { min-height: 400px; }
        .loading-msg {
            text-align: center;
            padding: 40px 20px;
            color: #9CA3AF;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="loading-msg" id="loading">Ödeme formu yükleniyor...</div>
    ${cached.html}
    <script>
        // Hide loading message once iyzico form renders
        var checkInterval = setInterval(function() {
            var form = document.getElementById('iyzipay-checkout-form');
            if (form && form.children.length > 0) {
                var loading = document.getElementById('loading');
                if (loading) loading.style.display = 'none';
                clearInterval(checkInterval);
            }
        }, 500);
        // Safety timeout
        setTimeout(function() { clearInterval(checkInterval); }, 30000);
    </script>
</body>
</html>`;
    }

    /**
     * Process guest payment with idempotency guard.
     *
     * Quote-then-Pay model:
     *   1. Create/find user
     *   2. Create job in PENDING_PAYMENT status (idempotent)
     *   3. Initiate payment via provider
     *   4. If provider returns CAPTURED (sandbox instant), confirm immediately
     *   5. If provider returns REQUIRES_ACTION, return redirect URL
     *   6. Confirmation happens later via handleWebhook()
     *
     * Idempotency: Redis-based check prevents duplicate jobs for the same quote.
     */
    async processGuestPayment(quoteData: any, guestInfo: any) {
        // ── 0. Validate input ──
        if (!quoteData?.pickupAddress || !quoteData?.dropoffAddress) {
            throw new BadRequestException({
                errorCode: 'VALIDATION_ERROR',
                message: 'Kalkış ve varış adresleri zorunludur',
            });
        }
        if (!guestInfo?.phone || !guestInfo?.firstName || !guestInfo?.lastName) {
            throw new BadRequestException({
                errorCode: 'VALIDATION_ERROR',
                message: 'Gerekli alanlar eksik: isim, soyisim, telefon',
            });
        }

        // ── 1. Idempotency check ──
        const idempotencyKey = this.idempotencyService.generateKey(
            'guest-payment', guestInfo.phone, quoteData.pickupAddress, quoteData.dropoffAddress, quoteData.vehicleType,
        );

        const isNew = await this.idempotencyService.checkAndSet(idempotencyKey, 3600);
        if (!isNew) {
            // Return cached result if available
            const cached = await this.idempotencyService.getStoredResult(idempotencyKey);
            if (cached) {
                this.logger.log(`⚡ Idempotent hit — returning cached result`);
                return cached;
            }
        }

        try {
            // ── 2. Find or Create User ──
            let user = await this.prisma.user.findFirst({
                where: {
                    OR: [
                        { phone: guestInfo.phone },
                        ...(guestInfo.email ? [{ email: guestInfo.email }] : []),
                    ].filter(Boolean) as any[],
                },
            });

            if (!user) {
                user = await this.prisma.user.create({
                    data: {
                        phone: guestInfo.phone,
                        email: guestInfo.email || null,
                        firstName: guestInfo.firstName,
                        lastName: guestInfo.lastName,
                        role: 'CUSTOMER',
                        isGuest: false,
                    },
                });
            } else {
                await this.prisma.user.update({
                    where: { id: user.id },
                    data: {
                        firstName: guestInfo.firstName || user.firstName,
                        lastName: guestInfo.lastName || user.lastName,
                    },
                });
            }

            // ── 3. Create Job in PENDING_PAYMENT status ──
            const job = await this.jobsService.createQuoteJob({
                customerId: user.id,
                guestName: `${guestInfo.firstName} ${guestInfo.lastName}`.trim(),
                guestPhone: guestInfo.phone,
                guestEmail: guestInfo.email || null,
                pickupAddress: quoteData.pickupAddress,
                dropoffAddress: quoteData.dropoffAddress,
                pickupLat: quoteData.pickupLat,
                pickupLng: quoteData.pickupLng,
                dropoffLat: quoteData.dropoffLat,
                dropoffLng: quoteData.dropoffLng,
                pickupPlaceId: quoteData.pickupPlaceId,
                dropoffPlaceId: quoteData.dropoffPlaceId,
                routePolyline: quoteData.routePolyline,
                vehicleType: quoteData.vehicleType,
                distanceKm: quoteData.distanceKm,
                durationMin: quoteData.durationMin,
                isDrivable: guestInfo.isDrivable,
                transmissionType: guestInfo.transmissionType,
                steeringWorks: guestInfo.steeringWorks,
                issueCategory: guestInfo.issueCategory,
                customerNotes: guestInfo.customerNotes,
                vehiclePlate: guestInfo.vehiclePlate,
                vehicleBrand: guestInfo.vehicleBrand,
                vehicleModel: guestInfo.vehicleModel,
            });

            // ── 4. Initiate payment via provider ──
            const paymentResult = await this.paymentProvider.initiate({
                jobId: job.id,
                amount: Number(job.estimatedPrice),
                currency: 'TRY',
                description: `BiÇekici Çekici Hizmeti #${job.id}`,
                callbackUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/callback`,
                buyer: {
                    firstName: guestInfo.firstName,
                    lastName: guestInfo.lastName,
                    phone: guestInfo.phone,
                    email: guestInfo.email,
                },
            });

            // ── 5. Create Payment Record ──
            await this.prisma.payment.create({
                data: {
                    jobId: job.id,
                    amount: job.estimatedPrice,
                    currency: 'TRY',
                    provider: this.paymentProvider.name,
                    status: paymentResult.status === 'CAPTURED' ? 'CAPTURED' : 'INITIATED',
                    providerPaymentId: paymentResult.providerPaymentId,
                },
            });

            // ── 6. If instant capture (sandbox default), confirm immediately ──
            if (paymentResult.status === 'CAPTURED') {
                await this.prisma.serviceRequest.update({
                    where: { id: job.id },
                    data: { status: 'MATCHING' },
                });

                // Dispatch to drivers
                await this.jobsService.dispatchJob(job.id);

                // Notify via socket
                this.realtimeGateway.notifyJobUpdate(job.id, 'job:status_changed', {
                    jobId: job.id,
                    status: 'MATCHING',
                    notificationText: 'Ödemeniz alındı, uygun çekici aranıyor.',
                });
            }

            // ── 7. Issue Token ──
            const tokenResult = await this.authService.login({
                email: user.email,
                id: user.id,
                role: user.role,
                firstName: user.firstName,
                lastName: user.lastName,
            });

            const result = {
                success: true,
                jobId: job.id,
                job,
                user,
                token: tokenResult.access_token,
                paymentStatus: paymentResult.status,
                actionUrl: paymentResult.actionUrl,
                htmlContent: paymentResult.htmlContent,
            };

            // Cache result for idempotency
            await this.idempotencyService.storeResult(idempotencyKey, result, 3600);

            return result;
        } catch (error) {
            // Release idempotency key on failure to allow retry
            await this.idempotencyService.release(idempotencyKey);
            throw error;
        }
    }

    /**
     * Mock/Sandbox Payment Confirm (backward compat for existing mobile clients).
     * Uses the PaymentProvider under the hood.
     */
    async mockConfirmPayment(quoteData: any, userId?: number) {
        if (!quoteData?.pickupAddress || !quoteData?.dropoffAddress) {
            throw new BadRequestException({
                errorCode: 'VALIDATION_ERROR',
                message: 'Quote verisi eksik: pickup/dropoff adresleri zorunlu',
            });
        }

        // Idempotency check
        const idempotencyKey = this.idempotencyService.generateKey(
            'mock', String(userId || 0), quoteData.pickupAddress, quoteData.dropoffAddress, quoteData.vehicleType,
        );

        const isNew = await this.idempotencyService.checkAndSet(idempotencyKey, 3600);
        if (!isNew) {
            const cached = await this.idempotencyService.getStoredResult(idempotencyKey);
            if (cached) return cached;
        }

        try {
            // Create job in PENDING_PAYMENT, then immediately confirm
            const job = await this.jobsService.createQuoteJob({
                customerId: userId || null,
                pickupAddress: quoteData.pickupAddress,
                dropoffAddress: quoteData.dropoffAddress,
                pickupLat: quoteData.pickupLat,
                pickupLng: quoteData.pickupLng,
                dropoffLat: quoteData.dropoffLat,
                dropoffLng: quoteData.dropoffLng,
                pickupPlaceId: quoteData.pickupPlaceId,
                dropoffPlaceId: quoteData.dropoffPlaceId,
                routePolyline: quoteData.routePolyline,
                vehicleType: quoteData.vehicleType,
                distanceKm: quoteData.distanceKm,
                durationMin: quoteData.durationMin,
            });

            // Initiate via sandbox provider (instant capture by default)
            const paymentResult = await this.paymentProvider.initiate({
                jobId: job.id,
                amount: Number(job.estimatedPrice),
                currency: 'TRY',
                description: `BiÇekici Mock #${job.id}`,
                callbackUrl: '',
                buyer: { firstName: 'Mock', lastName: 'User', phone: '' },
            });

            // Create payment record
            const payment = await this.prisma.payment.create({
                data: {
                    jobId: job.id,
                    amount: job.estimatedPrice,
                    currency: 'TRY',
                    provider: this.paymentProvider.name,
                    status: 'CAPTURED',
                    providerPaymentId: paymentResult.providerPaymentId,
                },
            });

            // Transition to MATCHING
            await this.prisma.serviceRequest.update({
                where: { id: job.id },
                data: { status: 'MATCHING' },
            });

            // Dispatch
            await this.jobsService.dispatchJob(job.id);

            // Notify
            this.realtimeGateway.notifyJobUpdate(job.id, 'job:status_changed', {
                jobId: job.id,
                status: 'MATCHING',
                notificationText: 'Ödemeniz alındı, uygun çekici aranıyor.',
            });

            this.logger.log(`✅ Mock payment confirmed for job #${job.id}`);

            const result = {
                success: true,
                jobId: job.id,
                status: 'MATCHING',
                paymentId: payment.id,
                amount: payment.amount,
                currency: payment.currency,
            };

            await this.idempotencyService.storeResult(idempotencyKey, result, 3600);
            return result;
        } catch (error) {
            await this.idempotencyService.release(idempotencyKey);
            throw error;
        }
    }
}
