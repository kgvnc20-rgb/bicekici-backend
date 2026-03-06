const io = require('socket.io-client');

// 1. Login to get token (Manual step or hardcoded for test)
// For this test, replace with a valid JWT token from /auth/login
const TOKEN = 'REPLACE_WITH_VALID_JWT_TOKEN';

const socket = io('http://localhost:3000', {
    auth: {
        token: TOKEN
    }
});

socket.on('connect', () => {
    console.log('Connected:', socket.id);

    // 2. Subscribe to a job
    socket.emit('job:subscribe', { jobId: 1 });
});

socket.on('disconnect', () => {
    console.log('Disconnected');
});

socket.on('exception', (data) => {
    console.error('Error:', data);
});

socket.on('job:assigned', (data) => {
    console.log('Job Assigned Event:', data);
});

socket.on('job:status_changed', (data) => {
    console.log('Job Status Changed:', data);
});

// simulate driver location update (if token is driver)
// socket.emit('driver:location_update', { lat: 41.0082, lng: 28.9784 });
