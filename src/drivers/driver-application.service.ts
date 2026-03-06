import { Injectable, ConflictException, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { v4 as uuid } from 'uuid';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

@Injectable()
export class DriverApplicationService {
    constructor(private readonly prisma: PrismaService) { }

    /** Normalize a Turkish phone number to +905XXXXXXXXX format */
    private normalizePhone(phone?: string): string {
        if (!phone) return '';
        const digits = phone.replace(/[\s\-\(\)]/g, '');
        if (digits.startsWith('+90')) return digits;
        if (digits.startsWith('90') && digits.length === 12) return '+' + digits;
        if (digits.startsWith('0') && digits.length === 11) return '+90' + digits.slice(1);
        if (digits.startsWith('5') && digits.length === 10) return '+90' + digits;
        return digits;
    }

    // ═══════════════════════════════════════
    //  PUBLIC ENDPOINTS (no login required)
    // ═══════════════════════════════════════

    /**
     * Public Step 1: Submit a driver application without login.
     * Returns { id, uploadToken } for subsequent document uploads.
     *
     * Uniqueness rules (enforced in service logic, not schema):
     * - PENDING or APPROVED application with same email OR phone → ConflictException
     * - REJECTED application with same email → allow re-apply (update existing record)
     */
    async submitPublic(data: {
        fullName: string;
        phone: string;
        email: string;
        city: string;
        district?: string;
        capabilities: string[];
        vehiclePlate: string;
    }) {
        // Check for existing application by email OR phone that is PENDING/APPROVED
        const existingByEmail = await this.prisma.driverApplication.findFirst({
            where: { email: data.email, status: { in: ['PENDING', 'APPROVED'] } },
        });
        if (existingByEmail) {
            if (existingByEmail.status === 'PENDING') {
                throw new ConflictException('Bu e-posta adresi ile zaten bekleyen bir başvuru bulunmaktadır.');
            }
            throw new ConflictException('Bu e-posta adresi ile onaylı bir başvuru bulunmaktadır.');
        }

        const existingByPhone = await this.prisma.driverApplication.findFirst({
            where: { phone: data.phone, status: { in: ['PENDING', 'APPROVED'] } },
        });
        if (existingByPhone) {
            if (existingByPhone.status === 'PENDING') {
                throw new ConflictException('Bu telefon numarası ile zaten bekleyen bir başvuru bulunmaktadır.');
            }
            throw new ConflictException('Bu telefon numarası ile onaylı bir başvuru bulunmaktadır.');
        }

        // Check for REJECTED application by email → allow re-apply
        const rejectedByEmail = await this.prisma.driverApplication.findFirst({
            where: { email: data.email, status: 'REJECTED' },
        });

        const uploadToken = uuid();

        if (rejectedByEmail) {
            const updated = await this.prisma.driverApplication.update({
                where: { id: rejectedByEmail.id },
                data: {
                    ...data,
                    status: 'PENDING',
                    rejectionReason: null,
                    uploadToken,
                },
            });
            return { id: updated.id, uploadToken };
        }

        // Create new application (no userId)
        const app = await this.prisma.driverApplication.create({
            data: {
                ...data,
                uploadToken,
            },
        });

        return { id: app.id, uploadToken };
    }

    /**
     * Public Step 2: Upload a document to an application using uploadToken.
     * No login required — the uploadToken acts as proof of ownership.
     */
    async addDocumentPublic(applicationId: number, uploadToken: string, doc: {
        docType: string;
        fileName: string;
        filePath: string;
        mimeType: string;
        fileSize: number;
    }) {
        const app = await this.prisma.driverApplication.findUnique({ where: { id: applicationId } });
        if (!app) throw new NotFoundException('Başvuru bulunamadı');
        if (app.status !== 'PENDING') throw new BadRequestException('Başvuru artık düzenlenemez');
        if (!app.uploadToken || app.uploadToken !== uploadToken) {
            throw new ForbiddenException('Geçersiz yükleme tokeni');
        }

        // Upsert by docType: replace if same type already uploaded
        const existing = await this.prisma.applicationDocument.findFirst({
            where: { applicationId, docType: doc.docType },
        });

        if (existing) {
            return this.prisma.applicationDocument.update({
                where: { id: existing.id },
                data: doc,
            });
        }

        return this.prisma.applicationDocument.create({
            data: { applicationId, ...doc },
        });
    }

    /**
     * Public: Get application status (minimal info only).
     */
    async getPublicStatus(applicationId: number) {
        const app = await this.prisma.driverApplication.findUnique({
            where: { id: applicationId },
            select: { id: true, status: true, createdAt: true },
        });
        if (!app) throw new NotFoundException('Başvuru bulunamadı');
        return app;
    }

    // ═══════════════════════════════════════
    //  AUTHENTICATED ENDPOINTS (legacy)
    // ═══════════════════════════════════════

    /**
     * Step 1 (authenticated): Create a driver application.
     * Returns the applicationId for subsequent document uploads.
     */
    async submit(userId: number, data: {
        fullName: string;
        phone: string;
        email: string;
        city: string;
        district?: string;
        capabilities: string[];
        vehiclePlate: string;
    }) {
        // Check if user already has an application
        const existing = await this.prisma.driverApplication.findUnique({ where: { userId } });
        if (existing) {
            if (existing.status === 'PENDING') {
                throw new ConflictException('Zaten bekleyen bir başvurunuz var');
            }
            if (existing.status === 'APPROVED') {
                throw new ConflictException('Başvurunuz zaten onaylanmış');
            }
            // If REJECTED, allow re-application by updating the existing record
            return this.prisma.driverApplication.update({
                where: { userId },
                data: {
                    ...data,
                    status: 'PENDING',
                    rejectionReason: null,
                },
                include: { documents: true },
            });
        }

        return this.prisma.driverApplication.create({
            data: {
                userId,
                ...data,
            },
            include: { documents: true },
        });
    }

    /**
     * Step 2 (authenticated): Add a document to an existing application.
     * Only the application owner can upload while status is PENDING.
     */
    async addDocument(applicationId: number, userId: number, doc: {
        docType: string;
        fileName: string;
        filePath: string;
        mimeType: string;
        fileSize: number;
    }) {
        const app = await this.prisma.driverApplication.findUnique({ where: { id: applicationId } });
        if (!app) throw new NotFoundException('Başvuru bulunamadı');
        if (app.userId !== userId) throw new ForbiddenException('Bu başvuruya erişim yetkiniz yok');
        if (app.status !== 'PENDING') throw new BadRequestException('Başvuru artık düzenlenemez');

        // Upsert by docType: replace if same type already uploaded
        const existing = await this.prisma.applicationDocument.findFirst({
            where: { applicationId, docType: doc.docType },
        });

        if (existing) {
            return this.prisma.applicationDocument.update({
                where: { id: existing.id },
                data: doc,
            });
        }

        return this.prisma.applicationDocument.create({
            data: { applicationId, ...doc },
        });
    }

    /** Get the current user's application with documents */
    async getMyApplication(userId: number) {
        return this.prisma.driverApplication.findUnique({
            where: { userId },
            include: { documents: true },
        });
    }

    // ═══════════════════════════════════════
    //  ADMIN ENDPOINTS
    // ═══════════════════════════════════════

    /** Admin: list all applications, optionally filtered by status */
    async getAll(status?: string) {
        const where = status ? { status: status as any } : {};
        return this.prisma.driverApplication.findMany({
            where,
            include: {
                documents: true,
                user: { select: { id: true, email: true, firstName: true, lastName: true, role: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /** Admin: get single application with all details */
    async getById(id: number) {
        const app = await this.prisma.driverApplication.findUnique({
            where: { id },
            include: {
                documents: true,
                user: { select: { id: true, email: true, firstName: true, lastName: true, role: true } },
            },
        });
        if (!app) throw new NotFoundException('Başvuru bulunamadı');
        return app;
    }

    /** Admin: get single document record */
    async getDocument(docId: number) {
        const doc = await this.prisma.applicationDocument.findUnique({ where: { id: docId } });
        if (!doc) throw new NotFoundException('Belge bulunamadı');
        return doc;
    }

    /**
     * Admin: Approve application.
     *
     * If no User exists for the application email:
     *   → Create User with bcrypt-hashed placeholder password (not loginable)
     *   → Generate DriverInviteToken (24h expiry)
     *   → Return inviteUrl for driver to set their 6-digit PIN
     *
     * Link application to User, upsert DriverProfile, invalidate uploadToken.
     * Idempotent: no-op if already approved.
     */
    async approve(applicationId: number) {
        const app = await this.prisma.driverApplication.findUnique({
            where: { id: applicationId },
            include: { user: true },
        });
        if (!app) throw new NotFoundException('Başvuru bulunamadı');

        // Idempotent: already approved with linked user
        if (app.status === 'APPROVED' && app.user?.role === 'DRIVER') {
            return { application: app, alreadyApproved: true };
        }

        let inviteToken: string | null = null;

        const result = await this.prisma.$transaction(async (tx) => {
            // 1. Find or create User
            let user = await tx.user.findUnique({ where: { email: app.email } });

            if (!user) {
                // Create User with non-loginable placeholder password
                const placeholderPlain = `INVITE_PENDING_${uuid()}`;
                const hashedPlaceholder = await bcrypt.hash(placeholderPlain, 10);

                // Split fullName into firstName + lastName
                const nameParts = app.fullName.trim().split(/\s+/);
                const firstName = nameParts[0];
                const lastName = nameParts.slice(1).join(' ') || undefined;

                user = await tx.user.create({
                    data: {
                        email: app.email,
                        password: hashedPlaceholder,
                        firstName,
                        lastName,
                        phone: this.normalizePhone(app.phone),
                        role: 'DRIVER',
                    },
                });
            } else {
                // Existing user — promote to DRIVER
                user = await tx.user.update({
                    where: { id: user.id },
                    data: { role: 'DRIVER' },
                });
            }

            // 2. Update application: link to user, approve, invalidate upload token
            const updated = await tx.driverApplication.update({
                where: { id: applicationId },
                data: {
                    status: 'APPROVED',
                    userId: user.id,
                    uploadToken: null,
                },
                include: { documents: true },
            });

            // 3. Upsert DriverProfile
            await tx.driverProfile.upsert({
                where: { userId: user.id },
                create: {
                    userId: user.id,
                    licenseNumber: app.vehiclePlate,
                    isOnline: false,
                },
                update: {},
            });

            // 4. Generate invite token (24h expiry)
            inviteToken = crypto.randomBytes(32).toString('hex');
            await tx.driverInviteToken.create({
                data: {
                    token: inviteToken,
                    userId: user.id,
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                },
            });

            return updated;
        });

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const inviteUrl = `${frontendUrl}/driver/set-pin?token=${inviteToken}`;

        console.log(`[APPROVE] Invite URL for ${app.email}: ${inviteUrl}`);

        return { application: result, alreadyApproved: false, inviteUrl };
    }

    /** Admin: Reject application with optional reason. Invalidates uploadToken. */
    async reject(applicationId: number, reason?: string) {
        const app = await this.prisma.driverApplication.findUnique({ where: { id: applicationId } });
        if (!app) throw new NotFoundException('Başvuru bulunamadı');

        if (app.status === 'REJECTED') {
            return { application: app, alreadyRejected: true };
        }

        const updated = await this.prisma.driverApplication.update({
            where: { id: applicationId },
            data: {
                status: 'REJECTED',
                rejectionReason: reason || null,
                uploadToken: null,
            },
            include: { documents: true },
        });

        return { application: updated, alreadyRejected: false };
    }
}
