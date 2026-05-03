
// --- SVG ICON STRINGS ---
const EYE_OPEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_CLOSED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('filename-input').value = generateDefaultFilename();
    
    document.getElementById('decrypt-file').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        if (file.name.endsWith('.skb') || file.name.endsWith('.json')) {
            document.getElementById('decrypt-password-container').style.display = 'block';
        } else {
            document.getElementById('decrypt-password-container').style.display = 'none';
            document.getElementById('decrypt-status').style.display = 'none';
        }
    });

    const draftNote = sessionStorage.getItem('safeKeepDraftNote') || localStorage.getItem('safeKeepDraftNote');
    if (draftNote) {
        document.getElementById('editor').innerHTML = draftNote;
        sessionStorage.removeItem('safeKeepDraftNote');
        localStorage.removeItem('safeKeepDraftNote');
        
        const statusBox = document.getElementById('encrypt-status');
        statusBox.className = 'status success';
        statusBox.innerText = '✅ Wallet data successfully imported!';
        setTimeout(() => { 
            statusBox.style.display = 'none'; 
            statusBox.innerText = '';
        }, 5000);
    }
});

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

// --- Optical Password Scanner ---
let html5QrCode = null;
let activeTargetInput = null;

window.openScanner = function(targetId) {
    activeTargetInput = targetId;
    document.getElementById('scannerModal').style.display = 'flex';
    
    html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
        { facingMode: "environment" },
        { fps: 15, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
            document.getElementById(activeTargetInput).value = decodedText;
            window.closeScanner();
        },
        (errorMessage) => { /* Ignore read errors while seeking */ }
    ).catch(err => alert("Camera error: " + err));
}

window.closeScanner = function() {
    if (html5QrCode) {
        html5QrCode.stop().then(() => {
            html5QrCode = null;
            document.getElementById('scannerModal').style.display = 'none';
        }).catch(e => console.error(e));
    } else {
        document.getElementById('scannerModal').style.display = 'none';
    }
}

function generateDefaultFilename() {
    const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, "");
    const timeStr = new Date().toTimeString().slice(0,5).replace(/:/g, "");
    return `workspace-${dateStr}-${timeStr}`;
}

window.togglePasswordVisibility = function() {
    const isChecked = document.getElementById('encrypt-checkbox').checked;
    document.getElementById('password-container').style.display = isChecked ? 'block' : 'none';
}

// --- UI Functions ---
window.switchTab = function(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    if (tab === 'encrypt') {
        document.querySelectorAll('.tab')[0].classList.add('active');
        document.getElementById('tab-encrypt').classList.add('active');
    } else {
        document.querySelectorAll('.tab')[1].classList.add('active');
        document.getElementById('tab-decrypt').classList.add('active');
    }
}

window.formatDoc = function(cmd, value = null) {
    document.execCommand(cmd, false, value);
    document.getElementById('editor').focus();
}

window.clearEditor = function() {
    if(confirm("Are you sure you want to clear the entire editor? This cannot be undone unless you have a saved backup.")) {
        document.getElementById('editor').innerHTML = "";
    }
}

window.toggleTheme = function() {
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme');
    const btn = document.getElementById('theme-btn');
    
    if (currentTheme === 'light') {
        html.removeAttribute('data-theme');
        localStorage.setItem('safekeepTheme', 'dark');
        btn.innerText = '☀️';
    } else {
        html.setAttribute('data-theme', 'light');
        localStorage.setItem('safekeepTheme', 'light');
        btn.innerText = '🌙';
    }
}

window.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('safekeepTheme') === 'light') {
        document.getElementById('theme-btn').innerText = '🌙';
    }
});

// --- Cryptography Helpers ---
const enc = new TextEncoder();
const dec = new TextDecoder();

async function getPasswordKey(password, salt) {
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToBuffer(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// --- ENCRYPT & SAVE WORKFLOW ---
window.saveNote = async function() {
    const text = document.getElementById('editor').innerHTML;
    const isEncrypted = document.getElementById('encrypt-checkbox').checked;
    const password = document.getElementById('encrypt-password').value;
    let filenameBase = document.getElementById('filename-input').value.trim();
    const statusBox = document.getElementById('encrypt-status');

    if (!filenameBase) filenameBase = generateDefaultFilename();

    if (!text || text === "<br>") {
        statusBox.className = 'status error';
        statusBox.innerText = 'Error: The workspace is empty.';
        return;
    }

    if (isEncrypted) {
        if (!password) {
            statusBox.className = 'status error';
            statusBox.innerText = 'Error: A password is required to encrypt and save.';
            return;
        }

        try {
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const iv = crypto.getRandomValues(new Uint8Array(12));

            const key = await getPasswordKey(password, salt);
            const ciphertext = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv: iv },
                key,
                enc.encode(text)
            );

            const encryptedPackage = {
                version: 1,
                format: "html",
                salt: bufferToBase64(salt),
                iv: bufferToBase64(iv),
                ciphertext: bufferToBase64(ciphertext)
            };

            downloadFile(JSON.stringify(encryptedPackage, null, 2), `${filenameBase}.skb`, 'application/json');
            
            statusBox.className = 'status success';
            statusBox.innerText = `Success! Encrypted workspace downloaded as ${filenameBase}.skb.`;
        } catch (err) {
            statusBox.className = 'status error';
            statusBox.innerText = 'Encryption failed: ' + err.message;
        }
    } else {
        downloadFile(text, `${filenameBase}.html`, 'text/html');
        statusBox.className = 'status success';
        statusBox.innerText = `Success! Unencrypted file downloaded as ${filenameBase}.html.`;
    }
}

function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// --- LOAD & DECRYPT WORKFLOW ---
window.processLoadedFile = async function() {
    const fileInput = document.getElementById('decrypt-file');
    const password = document.getElementById('decrypt-password').value;
    const statusBox = document.getElementById('decrypt-status');
    const editor = document.getElementById('editor');
    const filenameInput = document.getElementById('filename-input');

    if (!fileInput.files.length) {
        statusBox.className = 'status error';
        statusBox.innerText = 'Error: Please select a file to load.';
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async function(e) {
        const content = e.target.result;
        const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");

        try {
            const data = JSON.parse(content);
            
            if (data.salt && data.iv && data.ciphertext) {
                if (!password) {
                    statusBox.className = 'status error';
                    statusBox.innerText = 'Error: This file is encrypted. Please enter the decryption password.';
                    return;
                }

                const salt = base64ToBuffer(data.salt);
                const iv = base64ToBuffer(data.iv);
                const ciphertext = base64ToBuffer(data.ciphertext);

                const key = await getPasswordKey(password, salt);
                const decryptedBuffer = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: iv },
                    key,
                    ciphertext
                );

                editor.innerHTML = dec.decode(decryptedBuffer);
                
                document.getElementById('encrypt-checkbox').checked = true;
                window.togglePasswordVisibility();
                
                const pwdInput = document.getElementById('encrypt-password');
                pwdInput.value = password;
                pwdInput.type = 'password'; 
                // Reset to Open Eye SVG
                document.querySelector('#password-container .toggle-pwd-btn').innerHTML = EYE_OPEN_SVG;
                
            } else {
                editor.innerHTML = content;
                document.getElementById('encrypt-checkbox').checked = false;
                window.togglePasswordVisibility();
            }
        } catch (err) {
            if (err.name === 'SyntaxError') {
                editor.innerHTML = content;
                document.getElementById('encrypt-checkbox').checked = false;
                window.togglePasswordVisibility();
            } else {
                statusBox.className = 'status error';
                statusBox.innerText = 'Decryption failed. Incorrect password or corrupted file.';
                return;
            }
        }

        filenameInput.value = nameWithoutExt;
        
        const decryptPwdInput = document.getElementById('decrypt-password');
        decryptPwdInput.value = '';
        decryptPwdInput.type = 'password';
        document.querySelector('#decrypt-password-container .toggle-pwd-btn').innerHTML = EYE_OPEN_SVG;
        
        fileInput.value = '';
        statusBox.style.display = 'none';

        window.switchTab('encrypt');
        editor.focus();
    };

    reader.readAsText(file);
}