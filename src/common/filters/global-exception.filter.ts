import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global exception filter that:
 * 1. Logs the full stack trace server-side
 * 2. Returns structured { errorCode, message, statusCode } to clients
 * 3. Maps Prisma errors to meaningful error codes
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger('ExceptionFilter');

    catch(exception: any, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        // ── Determine status code ──
        let status = HttpStatus.INTERNAL_SERVER_ERROR;
        let errorCode = 'INTERNAL_ERROR';
        let message = 'Sunucu hatası oluştu';

        if (exception instanceof HttpException) {
            status = exception.getStatus();
            const exResponse = exception.getResponse();

            if (typeof exResponse === 'object' && exResponse !== null) {
                const obj = exResponse as any;
                errorCode = obj.errorCode || this.statusToErrorCode(status);
                message = obj.message || exception.message;
                // class-validator returns message as array
                if (Array.isArray(message)) {
                    message = message.join(', ');
                }
            } else {
                message = exception.message;
                errorCode = this.statusToErrorCode(status);
            }
        } else if (this.isPrismaError(exception)) {
            // Prisma Client Known Request Error
            const prismaResult = this.handlePrismaError(exception);
            status = prismaResult.status;
            errorCode = prismaResult.errorCode;
            message = prismaResult.message;
        } else if (exception?.message) {
            message = exception.message;
        }

        // ── Log full error server-side ──
        this.logger.error(
            `[${request.method}] ${request.url} → ${status} ${errorCode}: ${message}`,
            exception?.stack || exception,
        );

        // ── Return structured response ──
        response.status(status).json({
            statusCode: status,
            errorCode,
            message,
            path: request.url,
            timestamp: new Date().toISOString(),
        });
    }

    private statusToErrorCode(status: number): string {
        switch (status) {
            case 400: return 'BAD_REQUEST';
            case 401: return 'UNAUTHORIZED';
            case 403: return 'FORBIDDEN';
            case 404: return 'NOT_FOUND';
            case 409: return 'CONFLICT';
            case 422: return 'VALIDATION_ERROR';
            default: return 'INTERNAL_ERROR';
        }
    }

    private isPrismaError(exception: any): boolean {
        return exception?.constructor?.name === 'PrismaClientKnownRequestError'
            || exception?.code?.startsWith?.('P');
    }

    private handlePrismaError(exception: any): { status: number; errorCode: string; message: string } {
        switch (exception.code) {
            case 'P2002':
                return { status: 400, errorCode: 'DUPLICATE_ENTRY', message: 'Bu kayıt zaten mevcut' };
            case 'P2003':
                return { status: 400, errorCode: 'FOREIGN_KEY_ERROR', message: 'İlişkili kayıt bulunamadı' };
            case 'P2025':
                return { status: 404, errorCode: 'RECORD_NOT_FOUND', message: 'Kayıt bulunamadı' };
            default:
                return { status: 500, errorCode: 'DATABASE_ERROR', message: 'Veritabanı hatası: ' + exception.code };
        }
    }
}
