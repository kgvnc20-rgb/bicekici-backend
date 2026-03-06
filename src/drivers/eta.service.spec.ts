import { Test, TestingModule } from '@nestjs/testing';
import { EtaService } from './eta.service';
import { PrismaService } from '../prisma.service';
import { DriverPresenceService } from './driver-presence.service';

describe('EtaService', () => {
    let service: EtaService;
    let prisma: { serviceRequest: { findUnique: jest.Mock } };
    let presence: { getDriverLocation: jest.Mock };

    beforeEach(async () => {
        prisma = { serviceRequest: { findUnique: jest.fn() } };
        presence = { getDriverLocation: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EtaService,
                { provide: PrismaService, useValue: prisma },
                { provide: DriverPresenceService, useValue: presence },
            ],
        }).compile();

        service = module.get(EtaService);
    });

    it('returns null when job has no driver', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({ id: 1, driverId: null });

        const result = await service.calculateEta(1);
        expect(result).toBeNull();
    });

    it('returns null when job not found', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue(null);

        const result = await service.calculateEta(999);
        expect(result).toBeNull();
    });

    it('returns null when driver location unavailable', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 1, driverId: 5, status: 'EN_ROUTE_TO_PICKUP',
            pickupLat: 41.0, pickupLng: 29.0,
        });
        presence.getDriverLocation.mockResolvedValue(null);

        const result = await service.calculateEta(1);
        expect(result).toBeNull();
    });

    it('returns pickup ETA for EN_ROUTE_TO_PICKUP', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 1, driverId: 5, status: 'EN_ROUTE_TO_PICKUP',
            pickupLat: 41.05, pickupLng: 29.05,
            dropoffLat: 41.10, dropoffLng: 29.10,
        });
        presence.getDriverLocation.mockResolvedValue({
            lat: 41.0, lng: 29.0, ts: Date.now(), status: 'BUSY',
        });

        const result = await service.calculateEta(1);

        expect(result).not.toBeNull();
        expect(result!.targetType).toBe('PICKUP');
        expect(result!.etaMinutes).toBeGreaterThan(0);
        expect(result!.distanceKm).toBeGreaterThan(0);
        expect(result!.driverLat).toBe(41.0);
        expect(result!.driverLng).toBe(29.0);
    });

    it('returns dropoff ETA for EN_ROUTE_TO_DROPOFF', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 1, driverId: 5, status: 'EN_ROUTE_TO_DROPOFF',
            pickupLat: 41.0, pickupLng: 29.0,
            dropoffLat: 41.10, dropoffLng: 29.10,
        });
        presence.getDriverLocation.mockResolvedValue({
            lat: 41.05, lng: 29.05, ts: Date.now(), status: 'BUSY',
        });

        const result = await service.calculateEta(1);

        expect(result).not.toBeNull();
        expect(result!.targetType).toBe('DROPOFF');
        expect(result!.etaMinutes).toBeGreaterThan(0);
    });

    it('returns null for DELIVERED status', async () => {
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 1, driverId: 5, status: 'DELIVERED',
            pickupLat: 41.0, pickupLng: 29.0,
        });
        presence.getDriverLocation.mockResolvedValue({
            lat: 41.0, lng: 29.0, ts: Date.now(), status: 'ONLINE',
        });

        const result = await service.calculateEta(1);
        expect(result).toBeNull();
    });

    it('uses road factor so ETA is realistic', async () => {
        // ~7 km straight line between (41.0, 29.0) and (41.05, 29.05)
        prisma.serviceRequest.findUnique.mockResolvedValue({
            id: 1, driverId: 5, status: 'ASSIGNED',
            pickupLat: 41.05, pickupLng: 29.05,
        });
        presence.getDriverLocation.mockResolvedValue({
            lat: 41.0, lng: 29.0, ts: Date.now(), status: 'BUSY',
        });

        const result = await service.calculateEta(1);

        // Road distance ≈ 7km * 1.35 ≈ 9.5km → at 35 km/h ≈ 16 min
        expect(result!.distanceKm).toBeGreaterThan(5);
        expect(result!.distanceKm).toBeLessThan(15);
        expect(result!.etaMinutes).toBeGreaterThan(5);
        expect(result!.etaMinutes).toBeLessThan(30);
    });
});
