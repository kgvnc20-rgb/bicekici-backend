const io = require('socket.io-client');
const axios = require('axios');

// CONFIG
const API_URL = 'http://localhost:3000';
const DRIVER_EMAIL = 'driver@example.com';
const DRIVER_PASS = 'password123'; // Make sure this user exists or create automatically
const JOB_ID = process.argv[2] ? parseInt(process.argv[2]) : 1;

// SIMULATION PATH (Istanbul)
const PATH = [
    { lat: 41.0082, lng: 28.9784 }, // Start
    { lat: 41.0090, lng: 28.9790 },
    { lat: 41.0100, lng: 28.9800 },
    { lat: 41.0110, lng: 28.9810 },
    { lat: 41.0120, lng: 28.9820 },
    { lat: 41.0130, lng: 28.9830 }, // Destination approximate
];

async function main() {
    console.log('--- Driver Simulator ---');

    // 1. Login
    let token;
    try {
        console.log(`Logging in as ${DRIVER_EMAIL}...`);
        const res = await axios.post(`${API_URL}/auth/login`, {
            email: DRIVER_EMAIL,
            password: DRIVER_PASS
        });
        token = res.data.access_token;
        console.log('Login successful.');
    } catch (e) {
        console.error('Login failed:', e.response?.data || e.message);
        console.log('Hint: Ensure driver@example.com exists with role DRIVER');
        return;
    }

    // 2. Connect
    const socket = io(API_URL, {
        auth: { token }
    });

    socket.on('connect', () => {
        console.log(`Socket connected: ${socket.id}`);
        startSimulation(socket);
    });

    socket.on('disconnect', () => console.log('Socket disconnected'));
}

function startSimulation(socket) {
    let index = 0;
    console.log(`Starting simulation for Job ${JOB_ID} (if assigned)...`);

    // Simulate location updates every 2 seconds
    setInterval(() => {
        const point = PATH[index];

        // Add some jitter
        const lat = point.lat + (Math.random() - 0.5) * 0.0005;
        const lng = point.lng + (Math.random() - 0.5) * 0.0005;

        console.log(`Broadcasting location: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

        // Emit event
        socket.emit('driver:location_update', { lat, lng });

        // Loop path
        index = (index + 1) % PATH.length;
    }, 2000);
}

main();
