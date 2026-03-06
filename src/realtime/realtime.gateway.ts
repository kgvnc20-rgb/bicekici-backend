import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    OnGatewayConnection,
    OnGatewayDisconnect,
    ConnectedSocket,
    MessageBody,
    WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { forwardRef, Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DriversService } from '../drivers/drivers.service';
import { DriverPresenceService } from '../drivers/driver-presence.service';

@WebSocketGateway({
    cors: { origin: '*' },
    namespace: '/',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger('RealtimeGateway');

    @WebSocketServer()
    server!: Server;

    // Throttle map: socketId -> lastUpdateTime
    private lastLocationUpdate = new Map<string, number>();

    constructor(
        private jwtService: JwtService,
        private driversService: DriversService,
        private presenceService: DriverPresenceService,
    ) {
        // ── Fail fast if JWT_SECRET is not configured ──
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            const msg = '🔴 FATAL: JWT_SECRET environment variable is not set. Refusing to start with insecure defaults.';
            console.error(msg);
            throw new Error(msg);
        }
    }

    async handleConnection(client: Socket) {
        try {
            const token =
                client.handshake.auth.token ||
                client.handshake.headers.authorization?.split(' ')[1];

            if (!token) throw new Error('No token provided');

            const payload = this.jwtService.verify(token, {
                secret: process.env.JWT_SECRET,
            });

            client.data.user = payload;

            if (payload.role === 'GUEST') {
                // GUEST: auto-join their job room only
                if (payload.jobId) {
                    await client.join(`job:${payload.jobId}`);
                    client.data.guestJobId = payload.jobId;
                }
                this.logger.log(`Guest connected: socket=${client.id} jobId=${payload.jobId}`);
            } else {
                await client.join(`user:${payload.sub}`);

                if (payload.role === 'DRIVER') {
                    const profile = await this.driversService.ensureProfile(payload.sub);
                    client.data.driverProfileId = profile.id;
                    await client.join(`driver:${profile.id}`);
                    this.logger.log(`Driver connected: socket=${client.id} driverProfile=${profile.id}`);
                } else if (payload.role === 'ADMIN') {
                    await client.join('admin');
                    this.logger.log(`Admin connected: socket=${client.id} userId=${payload.sub}`);
                } else {
                    this.logger.log(`Customer connected: socket=${client.id} userId=${payload.sub}`);
                }
            }
        } catch (e: any) {
            this.logger.warn(`Connection rejected: ${e.message}`);
            client.disconnect();
        }
    }

    async handleDisconnect(client: Socket) {
        const user = client.data.user;
        this.lastLocationUpdate.delete(client.id);

        // If driver disconnects, mark offline
        if (user?.role === 'DRIVER' && client.data.driverProfileId) {
            await this.presenceService.setOffline(client.data.driverProfileId);

            // Notify admin
            this.server.to('admin').emit('driver:status', {
                driverProfileId: client.data.driverProfileId,
                status: 'OFFLINE',
                ts: Date.now(),
            });
        }

        this.logger.log(`Disconnected: ${client.id}`);
    }

    // ─── Driver Location Stream ───

    @SubscribeMessage('driver:location_update')
    async handleLocationUpdate(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { lat: number; lng: number; heading?: number; speed?: number },
    ) {
        const user = client.data.user;
        if (!user || user.role !== 'DRIVER') throw new WsException('Unauthorized');

        const driverProfileId = client.data.driverProfileId;
        if (!driverProfileId) throw new WsException('No driver profile');

        // Throttle: 1 second minimum
        const now = Date.now();
        const lastUpdate = this.lastLocationUpdate.get(client.id) || 0;
        if (now - lastUpdate < 1000) return;
        this.lastLocationUpdate.set(client.id, now);

        // Update Redis + (throttled) DB
        const loc = await this.presenceService.updateLocation(
            driverProfileId,
            data.lat,
            data.lng,
            data.heading,
            data.speed,
        );

        // Broadcast to admin room
        this.server.to('admin').emit('driver:location', {
            driverProfileId,
            ...loc,
        });

        // ── Relay to customer tracking: lookup active job from Redis (zero DB hits) ──
        const activeJobId = await this.presenceService.getDriverActiveJob(driverProfileId);
        if (activeJobId) {
            this.server.to(`job:${activeJobId}`).emit('driver:location', {
                jobId: activeJobId,
                driverProfileId,
                lat: loc.lat,
                lng: loc.lng,
                heading: loc.heading,
                speed: loc.speed,
                updatedAt: new Date().toISOString(),
            });
        }
    }

    // ─── Driver Status Change (callable from service layer) ───

    @SubscribeMessage('driver:go_online')
    async handleGoOnline(@ConnectedSocket() client: Socket) {
        this.logger.log(`driver:go_online received from socket=${client.id}`);
        const user = client.data.user;
        if (!user || user.role !== 'DRIVER') {
            this.logger.warn(`driver:go_online rejected: not DRIVER role`);
            throw new WsException('Unauthorized');
        }

        const profile = await this.driversService.ensureProfile(user.sub);
        client.data.driverProfileId = profile.id;

        await this.presenceService.setOnline(profile.id, user.sub);
        this.logger.log(`driver:go_online → presenceService.setOnline(${profile.id}) done`);

        // Store meta
        const userInfo = await this.driversService.getUserInfo(user.sub);
        const fullName = [userInfo?.firstName, userInfo?.lastName].filter(Boolean).join(' ') || userInfo?.email || `Sürücü #${profile.id}`;
        await this.presenceService.setMeta(profile.id, {
            name: fullName,
            plate: profile.licenseNumber || undefined,
            vehicleType: undefined,
            userId: user.sub,
            driverProfileId: profile.id,
        });

        // Notify admin
        this.server.to('admin').emit('driver:status', {
            driverProfileId: profile.id,
            status: 'ONLINE',
            ts: Date.now(),
        });

        this.logger.log(`driver:go_online complete: driverProfileId=${profile.id}`);
        return { status: 'ONLINE', driverProfileId: profile.id };
    }

    @SubscribeMessage('driver:go_offline')
    async handleGoOffline(@ConnectedSocket() client: Socket) {
        const user = client.data.user;
        if (!user || user.role !== 'DRIVER') throw new WsException('Unauthorized');

        const driverProfileId = client.data.driverProfileId;
        if (driverProfileId) {
            await this.presenceService.setOffline(driverProfileId);
            this.server.to('admin').emit('driver:status', {
                driverProfileId,
                status: 'OFFLINE',
                ts: Date.now(),
            });
        }
        return { status: 'OFFLINE' };
    }

    // ─── Job Room Management ───

    @SubscribeMessage('job:subscribe')
    async handleJobSubscribe(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { jobId: number },
    ) {
        const user = client.data.user;
        if (!user) throw new WsException('Unauthorized');

        // GUEST can only subscribe to their own job
        if (user.role === 'GUEST' && user.jobId !== data.jobId) {
            throw new WsException('Guests can only subscribe to their own job');
        }

        const room = `job:${data.jobId}`;
        await client.join(room);
        const socketsInRoom = this.server.sockets.adapter.rooms.get(room);
        const roomSize = socketsInRoom?.size || 0;
        this.logger.log(`📌 ${user.role} (userId=${user.sub}) joined "${room}" (now ${roomSize} socket(s))`);

        // ── Explicit ACK: confirm subscription to client ──
        client.emit('job:subscribe_ack', { jobId: data.jobId, roomSize });

        return { status: 'joined', jobId: data.jobId, roomSize };
    }

    @SubscribeMessage('job:unsubscribe')
    async handleJobUnsubscribe(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { jobId: number },
    ) {
        await client.leave(`job:${data.jobId}`);
        return { status: 'left', jobId: data.jobId };
    }

    // ─── Server-side Emit Methods (called from services) ───

    notifyJobUpdate(jobId: number, event: string, payload: any) {
        if (!this.server) {
            this.logger.warn(`⚠️ Server not ready — skipping emit "${event}" for job:${jobId}`);
            return;
        }
        const room = `job:${jobId}`;
        const socketsInRoom = this.server.sockets?.adapter?.rooms?.get(room);
        const count = socketsInRoom?.size || 0;
        this.logger.log(`📡 Emitting "${event}" to room "${room}" (${count} socket(s) in room)`);
        this.logger.debug(`   Payload: ${JSON.stringify(payload).slice(0, 300)}`);
        this.server.to(room).emit(event, payload);
        // Also notify admin room
        this.server.to('admin').emit('job:update', { jobId, event, ...payload });
    }

    notifyUser(userId: number, event: string, payload: any) {
        if (!this.server) return;
        this.server.to(`user:${userId}`).emit(event, payload);
    }

    notifyDriver(driverProfileId: number, event: string, payload: any) {
        if (!this.server) return;
        this.server.to(`driver:${driverProfileId}`).emit(event, payload);
    }

    notifyAdmin(event: string, payload: any) {
        if (!this.server) return;
        this.server.to('admin').emit(event, payload);
    }
}
