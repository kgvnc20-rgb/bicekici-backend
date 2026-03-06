import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
    getHello(): string {
        return 'BiÇekici Backend API is Running!';
    }
}
