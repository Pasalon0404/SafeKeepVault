import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';

// === UI & THEME HELPERS ===
document.getElementById('theme-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const html = document.documentElement;
    if (html.getAttribute('data-theme') === 'light') {
        html.removeAttribute('data-theme'); localStorage.setItem('safekeepTheme', 'dark'); e.target.innerText = '☀️';
    } else {
        html.setAttribute('data-theme', 'light'); localStorage.setItem('safekeepTheme', 'light'); e.target.innerText = '🌙';
    }
});
if (localStorage.getItem('safekeepTheme') === 'light') document.getElementById('theme-btn').innerText = '🌙';

// Tab Switching Logic
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
        e.preventDefault();
        // Stop any active processes when switching tabs
        stopTransmission();
        stopScanner();

        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        document.getElementById(e.target.getAttribute('data-target')).classList.add('active');
    });
});

// Utility Function: Checksum
function calculateSimpleChecksum(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum.toString(16).padStart(8, '0');
}

// ==========================================
// 1. TRANSMITTER LOGIC
// ==========================================
let transferInterval = null;
let fileChunks = [];
let transmitCurrentChunk = 0;
let transmitTotalChunks = 0;
let isTransferring = false;
let currentLoop = 0;
let originalFile = null;

document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        originalFile = file;
        document.getElementById('startTransmitBtn').disabled = false;
        const infoBox = document.getElementById('fileInfo');
        infoBox.innerHTML = `Loaded: <strong>${file.name}</strong> (${(file.size / 1024).toFixed(2)} KB)`;
        infoBox.style.display = 'block';
    }
});

document.getElementById('startTransmitBtn').addEventListener('click', async () => {
    const chunkSize = parseInt(document.getElementById('chunkSize').value);
    const fps = parseInt(document.getElementById('fps').value);
    
    document.getElementById('startTransmitBtn').style.display = 'none';
    document.getElementById('stopTransmitBtn').style.display = 'block';
    document.getElementById('qrDisplayContainer').style.display = 'block';
    
    fileChunks = await splitFileToChunks(originalFile, chunkSize);
    transmitTotalChunks = fileChunks.length;
    isTransferring = true;
    transmitCurrentChunk = 0;
    currentLoop = 0;

    startContinuousLoop(fps);
});

function stopTransmission() {
    isTransferring = false;
    document.getElementById('startTransmitBtn').style.display = 'block';
    document.getElementById('stopTransmitBtn').style.display = 'none';
    document.getElementById('transmitProgressBar').style.width = '0%';
}
document.getElementById('stopTransmitBtn').addEventListener('click', stopTransmission);

function startContinuousLoop(fps) {
    const frameDelay = 1000 / fps;
    function runLoop() {
        if (!isTransferring) return;
        if (transmitCurrentChunk < transmitTotalChunks) {
            sendChunk(fileChunks[transmitCurrentChunk], transmitCurrentChunk, transmitTotalChunks);
            transmitCurrentChunk++;
            document.getElementById('transmitProgressBar').style.width = `${(transmitCurrentChunk / transmitTotalChunks) * 100}%`;
            setTimeout(runLoop, frameDelay);
        } else {
            currentLoop++;
            transmitCurrentChunk = 0;
            document.getElementById('transmitProgressBar').style.width = '0%';
            setTimeout(runLoop, 500); 
        }
    }
    runLoop();
}

async function splitFileToChunks(file, chunkSize) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const uint8Array = new Uint8Array(e.target.result);
            const chunks = [];
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
                const chunk = uint8Array.slice(i, i + chunkSize);
                chunks.push({
                    data: arrayBufferToBase64(chunk),
                    checksum: calculateSimpleChecksum(chunk)
                });
            }
            resolve(chunks);
        };
        reader.readAsArrayBuffer(file);
    });
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) { binary += String.fromCharCode(bytes[i]); }
    return window.btoa(binary);
}

function sendChunk(chunk, index, total) {
    const fileName = originalFile.name;
    const lastDotIndex = fileName.lastIndexOf('.');
    const baseName = lastDotIndex > 0 ? fileName.substring(0, lastDotIndex) : fileName;
    const extension = lastDotIndex > 0 ? fileName.substring(lastDotIndex + 1) : '';
    const mimeType = originalFile.type || 'application/octet-stream';
    
    const qrData = `${currentLoop}/${index}/${total}~${encodeURIComponent(baseName)}~${encodeURIComponent(extension)}~${mimeType}~${chunk.data}~${chunk.checksum}`;
    const canvas = document.getElementById('qrCanvas');
    
    QRCode.toCanvas(canvas, qrData, {
        width: 700,
        margin: 2,
        errorCorrectionLevel: 'L',
        color: { dark: '#000000', light: '#ffffff' }
    }, function (error) {
        if (error) console.error(error);
    });
    
    document.getElementById('qrInfo').textContent = `Loop ${currentLoop + 1} | Chunk ${index + 1}/${total}`;
}

// ==========================================
// 2. RECEIVER LOGIC
// ==========================================
let html5QrCode = null;
let receivedChunks = new Map();
let receiveTotalChunks = null;
let receiveOriginalFilename = "";
let receiveOriginalExtension = "";
let receiveOriginalMimeType = "";
let completedFileBlob = null;

document.getElementById('startReceiveBtn').addEventListener('click', () => {
    document.getElementById('cameraBox').style.display = 'block';
    document.getElementById('startReceiveBtn').style.display = 'none';
    
    receivedChunks.clear();
    receiveTotalChunks = null;
    document.getElementById('receiveProgressBar').style.width = '0%';
    document.getElementById('receiveChunkCount').innerText = '0 / 0';
    document.getElementById('incomingFileName').innerText = 'Scanning...';

    html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
        { facingMode: "environment" },
        { fps: 15, qrbox: { width: 300, height: 300 } },
        (decodedText) => { processQRData(decodedText); },
        (errorMessage) => { /* ignore */ }
    ).catch(err => alert("Camera error: " + err));
});

function stopScanner() {
    if(html5QrCode) {
        html5QrCode.stop().then(() => {
            document.getElementById('cameraBox').style.display = 'none';
            document.getElementById('startReceiveBtn').style.display = 'block';
            html5QrCode = null;
        }).catch(e => console.error(e));
    }
}
document.getElementById('stopReceiveBtn').addEventListener('click', stopScanner);

function processQRData(qrData) {
    try {
        const parts = qrData.split('~');
        if (parts.length !== 6) return;
        
        const sequenceInfo = parts[0].split('/');
        const index = parseInt(sequenceInfo[1]);
        const total = parseInt(sequenceInfo[2]);
        const filename = decodeURIComponent(parts[1]);
        const extension = decodeURIComponent(parts[2]);
        const mimeType = parts[3];
        const data = parts[4];
        const checksum = parts[5];
        
        if (receiveTotalChunks === null) {
            receiveTotalChunks = total;
            receiveOriginalFilename = filename;
            receiveOriginalExtension = extension;
            receiveOriginalMimeType = mimeType;
            document.getElementById('incomingFileName').innerText = `${filename}.${extension}`;
        }
        
        if (!receivedChunks.has(index)) {
            const dataBytes = base64ToArrayBufferDecode(data);
            if (calculateSimpleChecksum(dataBytes) === checksum) {
                receivedChunks.set(index, data);
                
                document.getElementById('receiveChunkCount').innerText = `${receivedChunks.size} / ${receiveTotalChunks}`;
                document.getElementById('receiveProgressBar').style.width = `${(receivedChunks.size / receiveTotalChunks) * 100}%`;
                
                if (receivedChunks.size === receiveTotalChunks) onTransferComplete();
            }
        }
    } catch (e) { console.error('Parse error:', e); }
}

function base64ToArrayBufferDecode(base64) {
    const binaryString = window.atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) { bytes[i] = binaryString.charCodeAt(i); }
    return bytes;
}

function onTransferComplete() {
    stopScanner();

    const allBytes = [];
    for (let i = 0; i < receiveTotalChunks; i++) {
        const chunkBytes = base64ToArrayBufferDecode(receivedChunks.get(i));
        for (let j = 0; j < chunkBytes.length; j++) allBytes.push(chunkBytes[j]);
    }
    
    completedFileBlob = new Blob([new Uint8Array(allBytes)], { type: receiveOriginalMimeType });
    
    const suggestedName = receiveOriginalExtension ? `${receiveOriginalFilename}.${receiveOriginalExtension}` : receiveOriginalFilename;
    document.getElementById('modalFileDetails').innerText = suggestedName;
    document.getElementById('filenameInput').value = suggestedName;
    
    document.getElementById('downloadModal').style.display = 'flex';
}

document.getElementById('btn-close-modal').addEventListener('click', () => {
    document.getElementById('downloadModal').style.display = 'none';
});

document.getElementById('btn-download').addEventListener('click', () => {
    const filename = document.getElementById('filenameInput').value.trim() || 'received_file';
    const url = URL.createObjectURL(completedFileBlob);
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.getElementById('downloadModal').style.display = 'none';
});