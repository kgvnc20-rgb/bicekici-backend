
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

@Module({
    imports: [HttpModule],
    controllers: [GeoController],
    providers: [GeoService],
    exports: [GeoService],
})
export class GeoModule { }
