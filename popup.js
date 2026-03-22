const receiverIpInput = document.getElementById('receiverIp');
const statusDiv = document.getElementById('status');
const BACKEND_URL = 'http://localhost:8090'; // Backend server port

document.getElementById('startStream').addEventListener('click', async () => {
    const ip = receiverIpInput.value.trim();
    if (!ip) {
        statusDiv.textContent = 'Error: Please enter the receiver IP address.';
        return;
    }

    statusDiv.textContent = 'Status: Sending start command...';
    try {
        const encodedIp = encodeURIComponent(ip);
        const resp = await fetch(`${BACKEND_URL}/start?ip=${encodedIp}`);
        const data = await resp.json();
        
        statusDiv.textContent = `Status: ${data.message}`;
    } catch (err) {
        statusDiv.textContent = 'Error: Cannot connect to local backend. Is it running?';
        console.error('Fetch error:', err);
    }
});

document.getElementById('stopStream').addEventListener('click', async () => {
    statusDiv.textContent = 'Status: Sending stop command...';
    try {
        const resp = await fetch(`${BACKEND_URL}/stop`);
        const data = await resp.json();
        statusDiv.textContent = `Status: ${data.message}`;
    } catch (err) {
        statusDiv.textContent = 'Error: Cannot connect to local backend.';
        console.error('Fetch error:', err);
    }
});

// Load saved IP when the popup opens
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['receiverIp'], (result) => {
        if (result.receiverIp) {
            receiverIpInput.value = result.receiverIp;
        }
    });
});

// Save the IP address whenever it's changed
receiverIpInput.addEventListener('change', () => {
    chrome.storage.local.set({ receiverIp: receiverIpInput.value });
});