
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { Client, TravelMode, TrafficModel, UnitSystem, Language } from '@googlemaps/google-maps-services-js';
import { RedisService } from '../redis/redis.service';

const REVGEO_CACHE_TTL = 6 * 3600; // 6 hours in seconds

@Injectable()
export class GeoService {
    private client: Client;
    private apiKey = process.env.GOOGLE_MAPS_API_KEY;

    constructor(private readonly redis: RedisService) {
        this.client = new Client({});
        if (!this.apiKey) {
            console.error('GOOGLE_MAPS_API_KEY is missing in process.env');
        } else {
            console.log('GeoService initialized with Google Maps');
        }
    }

    // ─── Reverse Geocode (with Redis cache) ───

    async reverseGeocode(lat: number, lng: number): Promise<{ label: string; placeId?: string; lat: number; lng: number }> {
        if (!this.apiKey) {
            throw new HttpException('Google Maps API key missing', HttpStatus.INTERNAL_SERVER_ERROR);
        }

        // Round to 3 decimals (~111m precision) for cache dedup
        const rLat = Math.round(lat * 1000) / 1000;
        const rLng = Math.round(lng * 1000) / 1000;
        const cacheKey = `revgeo:${rLat}:${rLng}`;

        // Check cache
        const cached = await this.redis.getJSON<{ label: string; placeId?: string; lat: number; lng: number }>(cacheKey);
        if (cached) return { ...cached, lat, lng }; // Return original coords, cached label

        try {
            const response = await this.client.reverseGeocode({
                params: {
                    latlng: { lat, lng },
                    key: this.apiKey,
                    language: Language.tr,
                    result_type: ['street_address', 'route', 'neighborhood', 'sublocality', 'locality'] as any,
                },
            });

            const result = response.data.results[0];
            const place = {
                label: result?.formatted_address || 'Mevcut konum',
                placeId: result?.place_id,
                lat,
                lng,
            };

            // Cache (fire-and-forget)
            this.redis.setJSON(cacheKey, { label: place.label, placeId: place.placeId }, REVGEO_CACHE_TTL).catch(() => { });

            return place;
        } catch (error) {
            console.error('Google Reverse Geocode Error:', error.response?.data || error.message);
            // Fallback: return coords as label instead of throwing
            return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
        }
    }

    async autocomplete(query: string) {
        if (!this.apiKey) {
            throw new HttpException('Google Maps API key missing', HttpStatus.INTERNAL_SERVER_ERROR);
        }

        try {
            const response = await this.client.placeAutocomplete({
                params: {
                    input: query,
                    key: this.apiKey,
                    language: Language.tr,
                    components: ['country:tr'], // Restrict to Turkey
                },
            });

            return response.data.predictions.map((p) => ({
                label: p.description,
                placeId: p.place_id,
                main_text: p.structured_formatting.main_text,
                secondary_text: p.structured_formatting.secondary_text,
            }));
        } catch (error) {
            console.error('Google Places Autocomplete Error:', error.response?.data || error.message);
            throw new HttpException('Failed to fetch suggestions', HttpStatus.BAD_GATEWAY);
        }
    }

    async getPlaceDetails(placeId: string) {
        if (!this.apiKey) {
            throw new HttpException('Google Maps API key missing', HttpStatus.INTERNAL_SERVER_ERROR);
        }

        try {
            const response = await this.client.placeDetails({
                params: {
                    place_id: placeId,
                    key: this.apiKey,
                    fields: ['name', 'geometry', 'formatted_address'], // optimizing cost
                    language: Language.tr,
                },
            });

            const result = response.data.result;
            return {
                label: result.formatted_address || result.name,
                lat: result.geometry.location.lat,
                lng: result.geometry.location.lng,
                placeId: placeId,
            };
        } catch (error) {
            console.error('Google Place Details Error:', error.response?.data || error.message);
            throw new HttpException('Failed to fetch place details', HttpStatus.BAD_GATEWAY);
        }
    }

    async getRoute(
        start: { lat: number; lng: number },
        end: { lat: number; lng: number },
        preference: 'fastest' | 'shortest' = 'fastest'
    ) {
        if (!this.apiKey) {
            throw new HttpException('Google Maps API key missing', HttpStatus.INTERNAL_SERVER_ERROR);
        }

        try {
            const response = await this.client.directions({
                params: {
                    origin: { lat: start.lat, lng: start.lng },
                    destination: { lat: end.lat, lng: end.lng },
                    mode: TravelMode.driving,
                    traffic_model: TrafficModel.best_guess,
                    departure_time: 'now', // Required for traffic info
                    key: this.apiKey,
                    alternatives: true,
                    units: UnitSystem.metric,
                    language: Language.tr
                },
            });

            const routes = response.data.routes;
            if (!routes || routes.length === 0) {
                throw new HttpException('No route found', HttpStatus.NOT_FOUND);
            }

            // Google returns multiple routes if alternatives=true.
            // "fastest" is default (usually first route uses traffic).
            // "shortest" needs filtering by distance.
            // NOTE: shortest is not always returned by Google unless explicitly found, but we pick the best of what's returned.

            let selectedRoute = routes[0];

            if (preference === 'shortest') {
                // Find route with min distance
                selectedRoute = routes.reduce((prev, curr) => {
                    const prevDist = prev.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
                    const currDist = curr.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
                    return currDist < prevDist ? curr : prev;
                });
            } else {
                // Fastest: find route with min duration_in_traffic (if avail) or duration
                selectedRoute = routes.reduce((prev, curr) => {
                    const prevDur = prev.legs.reduce((sum, leg) => sum + (leg.duration_in_traffic?.value || leg.duration.value), 0);
                    const currDur = curr.legs.reduce((sum, leg) => sum + (leg.duration_in_traffic?.value || leg.duration.value), 0);
                    return currDur < prevDur ? curr : prev;
                });
            }

            const selectedIndex = routes.indexOf(selectedRoute);
            const leg = selectedRoute.legs[0]; // Assuming 1 leg for point A to B
            const distanceMeters = leg.distance.value;
            const durationSeconds = leg.duration.value;
            const trafficSeconds = (leg as any).duration_in_traffic?.value ?? null;

            const distanceKm = (distanceMeters / 1000).toFixed(2);
            // Prefer traffic-aware duration when available
            const durationMin = Math.round((trafficSeconds ?? durationSeconds) / 60);

            // Debug logging
            console.log(`[GeoService] Route selected (preference=${preference}):`);
            console.log(`  Index: ${selectedIndex} / ${routes.length} alternatives`);
            console.log(`  Distance: ${distanceMeters}m (${distanceKm} km)`);
            console.log(`  Duration: ${durationSeconds}s (${Math.round(durationSeconds / 60)} min)`);
            console.log(`  Duration in traffic: ${trafficSeconds !== null ? `${trafficSeconds}s (${Math.round(trafficSeconds / 60)} min)` : 'N/A'}`);
            console.log(`  departure_time: now (always set)`);
            console.log(`  Summary: ${selectedRoute.summary}`);

            return {
                distanceKm,
                durationMin,
                polyline: selectedRoute.overview_polyline.points,
                summary: selectedRoute.summary,
                debug: {
                    selectedRouteIndex: selectedIndex,
                    totalAlternatives: routes.length,
                    distanceMeters,
                    durationSeconds,
                    durationInTrafficSeconds: trafficSeconds,
                    usedTrafficDuration: trafficSeconds !== null,
                    departureTimeNow: true,
                    preference,
                    allRoutes: routes.map((r, i) => ({
                        index: i,
                        summary: r.summary,
                        distanceMeters: r.legs[0].distance.value,
                        durationSeconds: r.legs[0].duration.value,
                        durationInTrafficSeconds: (r.legs[0] as any).duration_in_traffic?.value ?? null,
                    })),
                },
            };

        } catch (error) {
            console.error('Google Directions Error:', error.response?.data || error.message);
            throw new HttpException('Failed to fetch route', HttpStatus.BAD_GATEWAY);
        }
    }
}
