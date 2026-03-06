
import { Controller, Get, Post, Query, Body, Req, HttpException, HttpStatus } from '@nestjs/common';
import { GeoService } from './geo.service';
import { Request } from 'express';
import { GetRouteDto } from './dto/geo.dto';

// Simple in-memory IP rate limiter for reverse-geocode
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;          // max requests
const RATE_WINDOW_MS = 60_000;  // per 1 minute

function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return true;
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
}

@Controller('geo')
export class GeoController {
    constructor(private readonly geoService: GeoService) { }

    @Get('autocomplete')
    async autocomplete(@Query('q') query: string) {
        if (!query || query.length < 2) return [];
        return this.geoService.autocomplete(query);
    }

    @Get('place-details')
    async getPlaceDetails(@Query('placeId') placeId: string) {
        if (!placeId) return null;
        return this.geoService.getPlaceDetails(placeId);
    }

    @Get('reverse-geocode')
    async reverseGeocode(
        @Query('lat') lat: string,
        @Query('lng') lng: string,
        @Req() req: Request,
    ) {
        if (!lat || !lng) return null;

        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        if (!checkRateLimit(ip)) {
            throw new HttpException('Too many reverse-geocode requests', HttpStatus.TOO_MANY_REQUESTS);
        }

        return this.geoService.reverseGeocode(parseFloat(lat), parseFloat(lng));
    }

    @Post('route')
    async getRoute(@Body() body: GetRouteDto) {
        return this.geoService.getRoute(body.pickup, body.dropoff, body.preference);
    }
}
