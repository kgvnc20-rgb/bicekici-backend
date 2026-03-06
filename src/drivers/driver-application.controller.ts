import {
    Controller, Post, Get, Body, Param, Query, Req, Res,
    UseGuards, UseInterceptors, UploadedFile,
    ParseIntPipe, HttpCode,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { createReadStream, existsSync } from 'fs';
import { Response, Request } from 'express';
import { DriverApplicationService } from './driver-application.service';
import { IsString, IsOptional, IsEmail, Matches, MinLength, IsArray } from 'class-validator';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { v4 as uuid } from 'uuid';

// ─── DTOs ───

class CreateApplicationDto {
    @IsString() @MinLength(2) fullName!: string;
    @IsString() @Matches(/^(\+90|0)?[5][0-9]{9}$/) phone!: string;
    @IsEmail() email!: string;
    @IsString() city!: string;
    @IsString() @IsOptional() district?: string;
    @IsArray() @IsString({ each: true }) capabilities!: string[];
    @IsString() vehiclePlate!: string;
}

class RejectDto {
    @IsString() @IsOptional() reason?: string;
}

// ─── File Validation ───

const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const uploadStorage = diskStorage({
    destination: './uploads/driver-documents',
    filename: (_req, file, cb) => {
        const uniqueName = `${uuid()}${extname(file.originalname)}`;
        cb(null, uniqueName);
    },
});

function fileFilter(_req: any, file: Express.Multer.File, cb: any) {
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
        return cb(new Error('Sadece JPEG, PNG ve PDF dosyaları kabul edilir'), false);
    }
    cb(null, true);
}

// ─── Controller ───

@ApiTags('Driver Applications')
@Controller('driver-applications')
export class DriverApplicationController {
    constructor(private readonly appService: DriverApplicationService) { }

    // ═══════════════════════════════════════
    //  PUBLIC (no login required)
    // ═══════════════════════════════════════

    @Post('public')
    @HttpCode(201)
    @ApiOperation({ summary: 'Public: Submit driver application (no login). Returns { id, uploadToken }' })
    async publicCreate(@Body() dto: CreateApplicationDto) {
        return this.appService.submitPublic(dto);
    }

    @Post('public/:id/documents')
    @UseInterceptors(FileInterceptor('file', {
        storage: uploadStorage,
        fileFilter,
        limits: { fileSize: MAX_FILE_SIZE },
    }))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({ summary: 'Public: Upload a document using uploadToken' })
    async publicUploadDocument(
        @Param('id', ParseIntPipe) id: number,
        @UploadedFile() file: Express.Multer.File,
        @Body('docType') docType: string,
        @Body('uploadToken') uploadToken: string,
    ) {
        if (!file) throw new Error('Dosya yüklenmedi');
        if (!docType) throw new Error('Belge türü belirtilmedi');
        if (!uploadToken) throw new Error('Upload token gereklidir');

        return this.appService.addDocumentPublic(id, uploadToken, {
            docType,
            fileName: file.originalname,
            filePath: file.path,
            mimeType: file.mimetype,
            fileSize: file.size,
        });
    }

    @Get('public/:id/status')
    @ApiOperation({ summary: 'Public: Check application status (minimal info)' })
    async publicStatus(@Param('id', ParseIntPipe) id: number) {
        return this.appService.getPublicStatus(id);
    }

    // ═══════════════════════════════════════
    //  AUTHENTICATED (legacy, backward compat)
    // ═══════════════════════════════════════

    @Post()
    @UseGuards(AuthGuard('jwt'))
    @HttpCode(201)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Step 1: Submit driver application (returns applicationId)' })
    async create(@Body() dto: CreateApplicationDto, @Req() req: any) {
        return this.appService.submit(req.user.userId, dto);
    }

    @Post(':id/documents')
    @UseGuards(AuthGuard('jwt'))
    @UseInterceptors(FileInterceptor('file', {
        storage: uploadStorage,
        fileFilter,
        limits: { fileSize: MAX_FILE_SIZE },
    }))
    @ApiBearerAuth()
    @ApiConsumes('multipart/form-data')
    @ApiOperation({ summary: 'Step 2: Upload a document to an existing application' })
    async uploadDocument(
        @Param('id', ParseIntPipe) id: number,
        @UploadedFile() file: Express.Multer.File,
        @Body('docType') docType: string,
        @Req() req: any,
    ) {
        if (!file) throw new Error('Dosya yüklenmedi');
        if (!docType) throw new Error('Belge türü belirtilmedi');

        return this.appService.addDocument(id, req.user.userId, {
            docType,
            fileName: file.originalname,
            filePath: file.path,
            mimeType: file.mimetype,
            fileSize: file.size,
        });
    }

    @Get('me')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get my application status and documents' })
    async getMyApplication(@Req() req: any) {
        return this.appService.getMyApplication(req.user.userId);
    }

    // ═══════════════════════════════════════
    //  ADMIN ONLY
    // ═══════════════════════════════════════

    @Get()
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN')
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Admin: List all driver applications' })
    async getAll(@Query('status') status?: string) {
        return this.appService.getAll(status);
    }

    @Get(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN')
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Admin: Get application details' })
    async getById(@Param('id', ParseIntPipe) id: number) {
        return this.appService.getById(id);
    }

    @Post(':id/approve')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN')
    @HttpCode(200)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Admin: Approve application (idempotent)' })
    async approve(@Param('id', ParseIntPipe) id: number) {
        return this.appService.approve(id);
    }

    @Post(':id/reject')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN')
    @HttpCode(200)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Admin: Reject application with optional reason' })
    async reject(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectDto) {
        return this.appService.reject(id, dto.reason);
    }

    /**
     * Admin-only document stream endpoint.
     * Documents are NOT publicly served; this endpoint requires JWT + ADMIN role.
     */
    @Get('documents/:docId/stream')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    @Roles('ADMIN')
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Admin: Stream/download a document file' })
    async streamDocument(
        @Param('docId', ParseIntPipe) docId: number,
        @Res() res: Response,
    ) {
        const doc = await this.appService.getDocument(docId);

        if (!existsSync(doc.filePath)) {
            res.status(404).json({ message: 'Dosya bulunamadı' });
            return;
        }

        res.setHeader('Content-Type', doc.mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);

        const stream = createReadStream(doc.filePath);
        stream.pipe(res);
    }
}
