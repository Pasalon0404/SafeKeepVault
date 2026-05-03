import QRCode from 'qrcode';

// --- SVG ICON STRINGS ---
const EYE_OPEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_CLOSED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

// --- UI Password Visibility Toggle ---
window.togglePasswordView = function(inputId, btnElement) {
    const input = document.getElementById(inputId);
    if (input.type === 'password') {
        input.type = 'text';
        btnElement.innerHTML = EYE_CLOSED_SVG;
    } else {
        input.type = 'password';
        btnElement.innerHTML = EYE_OPEN_SVG;
    }
}

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
        stopTransmission();
        stopScanner();

        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        document.getElementById(e.target.getAttribute('data-target')).classList.add('active');
    });
});

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

const modeRadios = document.querySelectorAll('input[name="transmitMode"]');
const fileSection = document.getElementById('file-mode-section');
const textSection = document.getElementById('text-mode-section');
const startTransmitBtn = document.getElementById('startTransmitBtn');
const stopTransmitBtn = document.getElementById('stopTransmitBtn');
const transmitProgressContainer = document.getElementById('transmitProgressContainer');
const textInput = document.getElementById('textInput');
const qrDisplayContainer = document.getElementById('qrDisplayContainer');

function generateStaticQR() {
    const textVal = textInput.value.trim();
    if (!textVal) {
        qrDisplayContainer.style.display = 'none';
        return;
    }
    
    qrDisplayContainer.style.display = 'block';
    const canvas = document.getElementById('qrCanvas');
    
    QRCode.toCanvas(canvas, textVal, {
        width: 525,
        margin: 2,
        errorCorrectionLevel: 'L',
        color: { dark: '#000000', light: '#ffffff' }
    }, function (error) {
        if (error) console.error(error);
    });
    
    document.getElementById('qrInfo').textContent = '';
}

modeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        stopTransmission();
        qrDisplayContainer.style.display = 'none';

        if (e.target.value === 'file') {
            fileSection.style.display = 'block';
            textSection.style.display = 'none';
            transmitProgressContainer.style.display = 'block';
            startTransmitBtn.style.display = 'block'; 
            startTransmitBtn.innerHTML = '▶️ Start Transmission Loop';
            startTransmitBtn.disabled = !originalFile;
        } else {
            fileSection.style.display = 'none';
            textSection.style.display = 'block';
            transmitProgressContainer.style.display = 'none';
            startTransmitBtn.style.display = 'none';  
            stopTransmitBtn.style.display = 'none';   
            generateStaticQR(); 
        }
    });
});

textInput.addEventListener('input', () => {
    if (document.querySelector('input[name="transmitMode"]:checked').value === 'text') {
        generateStaticQR();
    }
});

document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        originalFile = file;
        startTransmitBtn.disabled = false;
        const infoBox = document.getElementById('fileInfo');
        infoBox.innerHTML = `Loaded: <strong style="color: var(--teal);">${file.name}</strong> (${(file.size / 1024).toFixed(2)} KB)`;
        infoBox.style.display = 'block';
        infoBox.classList.add('active');
    }
});

document.getElementById('startTransmitBtn').addEventListener('click', async () => {
    const chunkSize = parseInt(document.getElementById('chunkSize').value);
    const fps = parseInt(document.getElementById('fps').value);
    
    startTransmitBtn.style.display = 'none';
    stopTransmitBtn.style.display = 'block';
    qrDisplayContainer.style.display = 'block';
    
    fileChunks = await splitFileToChunks(originalFile, chunkSize);
    transmitTotalChunks = fileChunks.length;
    isTransferring = true;
    transmitCurrentChunk = 0;
    currentLoop = 0;

    startContinuousLoop(fps);
});

function stopTransmission() {
    isTransferring = false;
    const mode = document.querySelector('input[name="transmitMode"]:checked').value;
    
    if (mode === 'file') {
        startTransmitBtn.style.display = 'block';
        stopTransmitBtn.style.display = 'none';
        document.getElementById('transmitProgressBar').style.width = '0%';
    }
}
stopTransmitBtn.addEventListener('click', stopTransmission);

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
        width: 525,
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

const staticResultContainer = document.getElementById('staticResultContainer');
const animatedReceiveUI = document.getElementById('animatedReceiveUI');

document.getElementById('startReceiveBtn').addEventListener('click', () => {
    document.getElementById('cameraBox').style.display = 'block';
    document.getElementById('startReceiveBtn').style.display = 'none';
    
    // Reset UIs
    staticResultContainer.style.display = 'none';
    animatedReceiveUI.style.display = 'block';
    document.getElementById('receivedTextInput').value = '';
    
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
        
        // SMART ROUTING: Check if this is an Animated Chunk or Static Text
        // We look for 6 parts AND a valid "loop/index/total" header in part[0]
        const isAnimatedChunk = parts.length === 6 && /^\d+\/\d+\/\d+$/.test(parts[0]);

        if (isAnimatedChunk) {
            // --- HANDLE ANIMATED FILE LOOP ---
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
        } else {
            // --- HANDLE STATIC TEXT / PASSWORD ---
            stopScanner();
            animatedReceiveUI.style.display = 'none';
            staticResultContainer.style.display = 'block';
            
            // Revert password field to masked mode automatically when a new one is scanned
            const pwdInput = document.getElementById('receivedTextInput');
            pwdInput.value = qrData;
            pwdInput.type = 'password';
            document.querySelector('#staticResultContainer .toggle-pwd-btn').innerHTML = EYE_OPEN_SVG;
        }

    } catch (e) { console.error('Parse error:', e); }
}

// Copy to Clipboard Logic
document.getElementById('copyStaticBtn').addEventListener('click', async (e) => {
    const textToCopy = document.getElementById('receivedTextInput').value;
    try {
        await navigator.clipboard.writeText(textToCopy);
        const originalText = e.target.innerText;
        e.target.innerText = 'Copied!';
        setTimeout(() => { e.target.innerText = originalText; }, 2000);
    } catch (err) {
        console.error('Failed to copy!', err);
    }
});

// Reset logic
document.getElementById('resetReceiveBtn').addEventListener('click', () => {
    staticResultContainer.style.display = 'none';
    animatedReceiveUI.style.display = 'block';
    document.getElementById('startReceiveBtn').click();
});

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